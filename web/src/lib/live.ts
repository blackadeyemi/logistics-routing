// One WebSocket to api-node for the whole dashboard (Phase 4). Pages
// subscribe to events; the socket reconnects by itself with back-off, and
// a page that missed events while disconnected refetches on reconnect
// ("reconnected" is delivered like any other event).
import { useEffect, useState } from 'react';
import { tokens } from './api';

export type LiveEvent =
  | { type: 'hello'; user_id: number }
  | { type: 'reconnected' }
  | { type: 'location'; driver_id: number; route_id: number | null; location: { lat: number; lng: number; accuracy_m: number | null }; recorded_at: string; eta: { stop_id: number; eta: string; minutes: number }[] }
  | { type: 'stop'; route_id: number; stop_id: number; order_id: number | null; action: string; route_status: string }
  | { type: 'route'; route_id?: number; route_date?: string; deleted?: boolean }
  | { type: 'orders'; order_id?: number };

export type LiveStatus = 'connecting' | 'live' | 'offline';

const listeners = new Set<(e: LiveEvent) => void>();
const statusListeners = new Set<(s: LiveStatus) => void>();
let socket: WebSocket | null = null;
let status: LiveStatus = 'offline';
let retry = 0;
let timer: number | undefined;
let wanted = false;
let everConnected = false;

function setStatus(s: LiveStatus) {
  status = s;
  statusListeners.forEach((fn) => fn(s));
}

function connect() {
  const token = tokens.get('staff');
  if (!wanted || !token || socket) return;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
  setStatus('connecting');
  const ws = new WebSocket(`${proto}://${window.location.host}${base}/ws?token=${encodeURIComponent(token)}`);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    setStatus('live');
    if (everConnected) listeners.forEach((fn) => fn({ type: 'reconnected' }));
    everConnected = true;
  };
  ws.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data as string) as LiveEvent;
      listeners.forEach((fn) => fn(e));
    } catch { /* ignore malformed */ }
  };
  ws.onclose = (ev) => {
    socket = null;
    setStatus('offline');
    // 4001: the token expired. The next API call signs the user out.
    if (!wanted || ev.code === 4001) return;
    retry = Math.min(retry + 1, 6);
    timer = window.setTimeout(connect, 1000 * 2 ** retry);
  };
}

export function startLive() {
  wanted = true;
  connect();
}

export function stopLive() {
  wanted = false;
  everConnected = false;
  window.clearTimeout(timer);
  socket?.close();
  socket = null;
}

/** Calls handler for every event while the component is mounted. */
export function useLiveEvents(handler: (e: LiveEvent) => void) {
  useEffect(() => {
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, [handler]);
}

export function useLiveStatus() {
  const [s, setS] = useState<LiveStatus>(status);
  useEffect(() => {
    statusListeners.add(setS);
    return () => {
      statusListeners.delete(setS);
    };
  }, []);
  return s;
}
