import type { EventType, LatLng, OrderStatus, RouteStatus, StopStatus } from './types';

// Operators work on Lagos time whatever the browser's timezone.
const TZ = 'Africa/Lagos';

export function todayLagos(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function fmtDay(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function fmtClock(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}

/** +2348031234567 shown as 0803 123 4567, the way people write it. */
export function fmtPhone(e164: string): string {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : e164;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

type Tone = 'success' | 'muted' | 'danger' | 'warning' | 'brand' | 'info';

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Unassigned', tone: 'warning' },
  assigned: { label: 'Assigned', tone: 'brand' },
  picked_up: { label: 'Picked up', tone: 'info' },
  en_route: { label: 'En route', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export const ROUTE_STATUS: Record<RouteStatus, { label: string; tone: Tone }> = {
  planned: { label: 'Planned', tone: 'muted' },
  in_progress: { label: 'In progress', tone: 'brand' },
  completed: { label: 'Completed', tone: 'success' },
};

export const STOP_STATUS: Record<StopStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'muted' },
  arrived: { label: 'Arrived', tone: 'brand' },
  completed: { label: 'Done', tone: 'success' },
  skipped: { label: 'Skipped', tone: 'danger' },
};

export const EVENT_LABEL: Record<EventType, string> = {
  created: 'Order created',
  updated: 'Details updated',
  assigned: 'Assigned to a route',
  unassigned: 'Taken off the route',
  arrived: 'Driver arrived',
  picked_up: 'Picked up',
  en_route: 'On the way to dropoff',
  delivered: 'Delivered',
  skipped: 'Stop skipped',
  cancelled: 'Cancelled',
};

/** Straight-line distance in km. Phase 1 has no road routing. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function pathKm(points: (LatLng | null)[]): number | null {
  const pts = points.filter((p): p is LatLng => !!p);
  if (pts.length < 2) return null;
  let km = 0;
  for (let i = 1; i < pts.length; i += 1) km += haversineKm(pts[i - 1]!, pts[i]!);
  return km;
}

export function mapsUrl(loc: LatLng | null, address: string): string {
  const q = loc ? `${loc.lat},${loc.lng}` : address;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
}
