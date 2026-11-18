// Offline core of the driver PWA.
//
// The day's route is cached so the app opens with no network. A tap is
// applied to the cached route at once using the same rules as the API, put
// in a queue with the tap time and a unique id, then sent when there is a
// connection. The API records the tap time and ignores repeats of the same
// id, so retrying is always safe.
import { ApiError, driverApi } from '../lib/api';
import type { DriverAction, Route, RouteStatus, RouteStop } from '../lib/types';

const ROUTE_KEY = 'lr_driver_route';
const QUEUE_KEY = 'lr_driver_queue';
const SYNCED_KEY = 'lr_driver_synced_at';

export interface QueuedAction {
  id: string;
  stopId: number;
  action: DriverAction;
  occurredAt: string;
}

export interface CachedDay {
  route: Route | null;
  syncedAt: string | null;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the app still works while it stays open.
  }
}

export function cachedDay(): CachedDay {
  return { route: load<Route | null>(ROUTE_KEY, null), syncedAt: load<string | null>(SYNCED_KEY, null) };
}
export function queue(): QueuedAction[] {
  return load<QueuedAction[]>(QUEUE_KEY, []);
}
export function clearDriverData() {
  [ROUTE_KEY, QUEUE_KEY, SYNCED_KEY].forEach((k) => {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  });
}

// crypto.randomUUID needs a secure context, which a phone on the office LAN
// over plain http is not.
function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function routeStatus(stops: RouteStop[]): RouteStatus {
  if (stops.length && stops.every((s) => s.status === 'completed' || s.status === 'skipped')) return 'completed';
  if (stops.some((s) => s.status !== 'pending')) return 'in_progress';
  return 'planned';
}

/** What the driver can do on a stop right now, best first. */
export function availableActions(route: Route, stop: RouteStop): DriverAction[] {
  if (stop.order_status === 'cancelled') return [];
  if (stop.status === 'completed' || stop.status === 'skipped') return [];
  if (stop.stop_type === 'pickup') {
    return stop.status === 'pending' ? ['complete', 'arrive', 'skip'] : ['complete', 'skip'];
  }
  const pickup = route.stops.find((s) => s.order_id === stop.order_id && s.stop_type === 'pickup');
  if (pickup && pickup.status !== 'completed') return [];
  if (stop.status === 'arrived') return ['complete', 'skip'];
  if (stop.order_status === 'picked_up') return ['start', 'arrive', 'complete', 'skip'];
  return ['arrive', 'complete', 'skip'];
}

/** Same transitions as applyDriverAction in api-node/src/dispatch.js. */
export function applyLocal(route: Route, stopId: number, action: DriverAction, at: string): Route {
  const stop = route.stops.find((s) => s.id === stopId);
  if (!stop || !availableActions(route, stop).includes(action)) return route;
  let stops = route.stops.map((s) => ({ ...s }));
  const same = (s: RouteStop) => s.order_id === stop.order_id;
  const target = stops.find((s) => s.id === stopId)!;

  switch (action) {
    case 'arrive':
      target.status = 'arrived';
      target.arrived_at = at;
      break;
    case 'complete': {
      target.status = 'completed';
      target.arrived_at = target.arrived_at ?? at;
      target.completed_at = at;
      const next = stop.stop_type === 'pickup' ? 'picked_up' : 'delivered';
      stops.filter(same).forEach((s) => { s.order_status = next; });
      break;
    }
    case 'start':
      stops.filter(same).forEach((s) => { s.order_status = 'en_route'; });
      break;
    case 'skip':
      if (stop.stop_type === 'pickup') {
        stops = stops.filter((s) => !same(s)).map((s, i) => ({ ...s, sequence_number: i + 1 }));
      } else {
        target.status = 'skipped';
      }
      break;
  }
  return { ...route, stops, status: routeStatus(stops) };
}

/** Records a tap: updates the cached route and queues it for the API. */
export function recordTap(route: Route, stopId: number, action: DriverAction): Route {
  const at = new Date().toISOString();
  const next = applyLocal(route, stopId, action, at);
  save(ROUTE_KEY, next);
  save(QUEUE_KEY, [...queue(), { id: uuid(), stopId, action, occurredAt: at }]);
  return next;
}

export interface SyncResult {
  route: Route | null;
  syncedAt: string | null;
  pending: number;
  /** Updates the API refused, for example a stop the dispatcher removed. */
  rejected: string[];
  offline: boolean;
}

/**
 * Sends queued taps in order, then fetches the day's route. Stops at the
 * first network failure and keeps the rest queued. The returned route is the
 * server's, with anything still queued re-applied on top.
 */
export async function sync(): Promise<SyncResult> {
  const rejected: string[] = [];
  let items = queue();
  while (items.length) {
    const item = items[0]!;
    try {
      await driverApi(`/driver/stops/${item.stopId}/status`, {
        method: 'POST', quiet: true,
        body: { action: item.action, occurred_at: item.occurredAt, client_event_id: item.id },
      });
    } catch (err) {
      if (err instanceof ApiError && (err.offline || err.status === 401 || err.status >= 500)) {
        const day = cachedDay();
        return { route: day.route, syncedAt: day.syncedAt, pending: items.length, rejected, offline: err.offline, };
      }
      rejected.push(err instanceof ApiError ? err.message : 'Update refused');
    }
    items = items.slice(1);
    save(QUEUE_KEY, items);
  }

  try {
    const { route } = await driverApi<{ route: Route | null }>('/driver/route', { quiet: true });
    const syncedAt = new Date().toISOString();
    // Taps made while this request was in flight are still in the queue.
    const merged = queue().reduce<Route | null>((r, q) => (r ? applyLocal(r, q.stopId, q.action, q.occurredAt) : r), route);
    save(ROUTE_KEY, merged);
    save(SYNCED_KEY, syncedAt);
    return { route: merged, syncedAt, pending: queue().length, rejected, offline: false };
  } catch (err) {
    const day = cachedDay();
    return { route: day.route, syncedAt: day.syncedAt, pending: queue().length, rejected, offline: err instanceof ApiError && err.offline };
  }
}
