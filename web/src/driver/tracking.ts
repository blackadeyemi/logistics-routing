// Location sharing for the driver app (Phase 4).
//
// While today's route is active, the app watches the GPS and records one
// point every 30 seconds, then sends the points it has in batches. Points
// are queued on the phone like stop updates, so a dead zone delays them
// rather than losing them, and each keeps the time it was taken.
//
// Browsers pause timers and GPS when the screen is off or the app is in
// the background. Every point records whether the app was on screen, so
// the dashboard can measure how much that costs (the case for Phase 7's
// native app). Nothing here tries to work around it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, driverApi } from '../lib/api';
import { todayLagos } from '../lib/format';
import type { Route } from '../lib/types';

export const INTERVAL_MS = 30_000;
const QUEUE_KEY = 'lr_driver_locations';
const OPT_IN_KEY = 'lr_share_location';
const MAX_QUEUE = 3000;
const BATCH = 500;

interface Point {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  app_visible: boolean;
  recorded_at: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: points are kept in memory for this session.
  }
}

export const locationQueue = () => read<Point[]>(QUEUE_KEY, []);

/** The driver tapped "Share location" today (asked once per day). */
const optedInToday = () => read<string | null>(OPT_IN_KEY, null) === todayLagos();

export type SharingState = 'off' | 'starting' | 'on' | 'denied' | 'unsupported';

/**
 * Shares location while the route is active: automatically once the route
 * is under way, or from the moment the driver taps Share location.
 */
export function useLocationSharing(route: Route | null) {
  const [state, setState] = useState<SharingState>(() => ('geolocation' in navigator ? 'off' : 'unsupported'));
  const [optIn, setOptIn] = useState(optedInToday);
  const [queued, setQueued] = useState(() => locationQueue().length);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [lastFix, setLastFix] = useState<GeolocationPosition | null>(null);
  const fix = useRef<GeolocationPosition | null>(null);
  const sending = useRef(false);

  const active = !!route && route.route_date === todayLagos() && route.status !== 'completed' && (route.status === 'in_progress' || optIn);

  const flush = useCallback(async () => {
    if (sending.current || !navigator.onLine) return;
    sending.current = true;
    try {
      let q = locationQueue();
      while (q.length) {
        const batch = q.slice(0, BATCH);
        await driverApi('/driver/locations', { method: 'POST', body: { points: batch }, quiet: true });
        q = locationQueue().slice(batch.length);
        write(QUEUE_KEY, q);
        setQueued(q.length);
        setLastSent(new Date().toISOString());
      }
    } catch (err) {
      // A rejected batch (400) would block the queue forever: drop it.
      if (err instanceof ApiError && err.status === 400) {
        write(QUEUE_KEY, locationQueue().slice(BATCH));
        setQueued(locationQueue().length);
      }
    } finally {
      sending.current = false;
    }
  }, []);

  const record = useCallback(() => {
    const f = fix.current;
    if (!f) return;
    const q = locationQueue();
    const at = new Date(f.timestamp).toISOString();
    // The same fix twice (no new GPS reading since the last tick) adds nothing.
    if (q.length && q[q.length - 1]!.recorded_at === at) return;
    q.push({
      lat: Math.round(f.coords.latitude * 1e6) / 1e6,
      lng: Math.round(f.coords.longitude * 1e6) / 1e6,
      accuracy_m: f.coords.accuracy != null ? Math.round(f.coords.accuracy) : null,
      speed_mps: f.coords.speed != null && f.coords.speed >= 0 ? f.coords.speed : null,
      heading_deg: f.coords.heading != null && !Number.isNaN(f.coords.heading) ? f.coords.heading : null,
      app_visible: document.visibilityState === 'visible',
      recorded_at: at,
    });
    const kept = q.slice(-MAX_QUEUE);
    write(QUEUE_KEY, kept);
    setQueued(kept.length);
  }, []);

  useEffect(() => {
    if (!active || state === 'unsupported') {
      if (state === 'on' || state === 'starting') setState('off');
      return undefined;
    }
    setState((s) => (s === 'on' ? s : 'starting'));
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const first = !fix.current;
        fix.current = pos;
        setLastFix(pos);
        setState('on');
        if (first) {
          record();
          void flush();
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setState('denied');
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 60_000 },
    );
    const tick = window.setInterval(() => {
      record();
      void flush();
    }, INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        record();
        void flush();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', flush);
    return () => {
      navigator.geolocation.clearWatch(watch);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', flush);
    };
    // state is read only to avoid a flash back to "starting"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, record, flush]);

  const start = () => {
    write(OPT_IN_KEY, todayLagos());
    setOptIn(true);
  };

  return { state, active, queued, lastSent, lastFix, start, canStart: !!route && route.status !== 'completed' && !active };
}
