// Thin fetch wrapper for api-node. In development Vite proxies /api to the
// API container, so the browser never needs CORS. Staff and drivers keep
// separate tokens, so a dispatcher can test the driver app in one browser.

export type Session = 'staff' | 'driver';

const BASE: string = import.meta.env.VITE_API_URL ?? '/api';
const TOKEN_KEY: Record<Session, string> = { staff: 'lr_staff_token', driver: 'lr_driver_token' };

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
  /** True when the request never reached the server. */
  get offline() {
    return this.status === 0;
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const tokens = {
  get(s: Session) {
    return storage()?.getItem(TOKEN_KEY[s]) ?? null;
  },
  set(s: Session, token: string) {
    storage()?.setItem(TOKEN_KEY[s], token);
  },
  clear(s: Session) {
    storage()?.removeItem(TOKEN_KEY[s]);
  },
};

// In-flight counter drives the GDS top progress bar.
let inflight = 0;
const progressListeners = new Set<(busy: boolean) => void>();
export function onProgress(fn: (busy: boolean) => void) {
  progressListeners.add(fn);
  return () => {
    progressListeners.delete(fn);
  };
}
function bump(delta: number) {
  inflight = Math.max(0, inflight + delta);
  progressListeners.forEach((fn) => fn(inflight > 0));
}

type Query = Record<string, string | number | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Skip the progress bar, for background polling. */
  quiet?: boolean;
}

export async function request<T>(session: Session, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokens.get(session);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  if (!opts.quiet) bump(1);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'No connection. Check your network and try again.');
  } finally {
    if (!opts.quiet) bump(-1);
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) {
      tokens.clear(session);
      window.dispatchEvent(new CustomEvent('auth:expired', { detail: session }));
    }
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

export const staffApi = <T>(path: string, opts?: RequestOptions) => request<T>('staff', path, opts);
export const driverApi = <T>(path: string, opts?: RequestOptions) => request<T>('driver', path, opts);

/** Field errors from a 400 response, keyed by field path. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 400 || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details as { path: string; message: string }[]) {
    if (d.path && !out[d.path]) out[d.path] = d.message;
  }
  return out;
}

/** Messages from a 409 response that lists each problem. */
export function conflictMessages(err: unknown): string[] {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return [];
  return (err.details as { message?: string }[]).map((d) => d.message ?? '').filter(Boolean);
}
