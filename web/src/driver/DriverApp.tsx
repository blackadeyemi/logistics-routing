import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { AppearanceControls, ErrorAlert, Mark, StopBadge, useClickOutside, useOnline } from '../components/ui';
import { ApiError, driverApi, tokens } from '../lib/api';
import { fmtDay, fmtPhone, fmtTime, mapsUrl, todayLagos } from '../lib/format';
import type { DriverAction, Route, RouteStop } from '../lib/types';
import { availableActions, cachedDay, clearDriverData, queue, recordTap, sync } from './store';

interface DriverInfo { id: number; name: string; phone: string }
const DRIVER_KEY = 'lr_driver_me';

function savedDriver(): DriverInfo | null {
  try {
    const raw = localStorage.getItem(DRIVER_KEY);
    return raw && tokens.get('driver') ? (JSON.parse(raw) as DriverInfo) : null;
  } catch {
    return null;
  }
}

export function DriverApp() {
  const [me, setMe] = useState<DriverInfo | null>(savedDriver);

  useEffect(() => {
    const onExpired = (e: Event) => {
      if ((e as CustomEvent).detail === 'driver') setMe(null);
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const logout = () => {
    tokens.clear('driver');
    clearDriverData();
    try { localStorage.removeItem(DRIVER_KEY); } catch { /* ignore */ }
    setMe(null);
  };

  return (
    <div className="driver-app">
      {me ? <DriverDay me={me} onLogout={logout} /> : <DriverLogin onLogin={(d) => {
        try { localStorage.setItem(DRIVER_KEY, JSON.stringify(d)); } catch { /* ignore */ }
        setMe(d);
      }} />}
    </div>
  );
}

function DriverLogin({ onLogin }: { onLogin: (d: DriverInfo) => void }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const online = useOnline();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await driverApi<{ token: string; driver: DriverInfo }>('/auth/driver-login', { method: 'POST', body: { phone, pin } });
      tokens.set('driver', res.token);
      onLogin(res.driver);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
      setBusy(false);
    }
  };

  return (
    <div className="driver-login">
      <div className="driver-login-brand"><Mark size={56} /><h1>Driver</h1><p>Your stops for today, even with poor network.</p></div>
      <form className="card card-pad" onSubmit={submit}>
        {!online && <div className="alert alert-warning">You are offline. Connect once to log in, then the app works offline.</div>}
        <ErrorAlert error={error} />
        <div className="form-group">
          <label className="form-label" htmlFor="phone">Phone number</label>
          <input id="phone" className="form-control driver-input mono" inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" required value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="pin">PIN</label>
          <input id="pin" className="form-control driver-input mono pin-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          <div className="form-hint">Your dispatcher gives you this PIN.</div>
        </div>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !online}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
    </div>
  );
}

// Chrome's install prompt, offered from the menu instead of a browser banner.
type InstallEvent = Event & { prompt: () => Promise<void> };
function useInstallPrompt() {
  const [evt, setEvt] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e as InstallEvent); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  return evt ? async () => { await evt.prompt(); setEvt(null); } : null;
}

const ACTION_LABEL: Record<DriverAction, (s: RouteStop) => string> = {
  arrive: () => 'I have arrived',
  start: () => 'Start trip to dropoff',
  complete: (s) => (s.stop_type === 'pickup' ? 'Picked up' : 'Delivered'),
  skip: (s) => (s.stop_type === 'pickup' ? 'Cannot pick up' : 'Delivery failed'),
};

function DriverDay({ me, onLogout }: { me: DriverInfo; onLogout: () => void }) {
  const online = useOnline();
  const [route, setRoute] = useState<Route | null>(() => cachedDay().route);
  const [syncedAt, setSyncedAt] = useState<string | null>(() => cachedDay().syncedAt);
  const [pending, setPending] = useState(() => queue().length);
  const [syncing, setSyncing] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [confirmSkip, setConfirmSkip] = useState<RouteStop | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useClickOutside<HTMLDivElement>(menuOpen, () => setMenuOpen(false));
  const install = useInstallPrompt();
  const running = useRef(false);

  const runSync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSyncing(true);
    try {
      const r = await sync();
      setRoute(r.route);
      setSyncedAt(r.syncedAt);
      setPending(r.pending);
      if (r.rejected.length) setNotices((n) => [...n, ...r.rejected.map((m) => `An update was not accepted: ${m}`)]);
    } finally {
      running.current = false;
      setSyncing(false);
    }
  }, []);

  // Sync on open, when the connection returns, when the app comes back to
  // the foreground, and every minute while open.
  useEffect(() => {
    void runSync();
    const onVisible = () => document.visibilityState === 'visible' && void runSync();
    window.addEventListener('online', runSync);
    document.addEventListener('visibilitychange', onVisible);
    const t = window.setInterval(() => navigator.onLine && document.visibilityState === 'visible' && void runSync(), 60_000);
    return () => {
      window.removeEventListener('online', runSync);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(t);
    };
  }, [runSync]);

  const tap = (stop: RouteStop, action: DriverAction) => {
    if (!route) return;
    if (action === 'skip' && confirmSkip?.id !== stop.id) { setConfirmSkip(stop); return; }
    setConfirmSkip(null);
    setRoute(recordTap(route, stop.id, action));
    setPending(queue().length);
    if (navigator.vibrate) navigator.vibrate(30);
    if (navigator.onLine) void runSync();
  };

  const { next, upcoming, done } = useMemo(() => {
    const stops = route?.stops ?? [];
    const open = stops.filter((s) => s.status === 'pending' || s.status === 'arrived');
    return {
      next: open.find((s) => availableActions(route!, s).length > 0) ?? null,
      upcoming: open,
      done: stops.filter((s) => s.status === 'completed' || s.status === 'skipped'),
    };
  }, [route]);

  const stale = route && route.route_date !== todayLagos();
  const total = route?.stops.length ?? 0;

  return (
    <>
      <header className="driver-bar">
        <Mark size={30} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="driver-bar-name truncate">{me.name}</div>
          <div className="driver-bar-sub">{route ? fmtDay(route.route_date) : fmtDay(todayLagos())}</div>
        </div>
        <button className="driver-bar-btn" onClick={() => void runSync()} disabled={syncing || !online} aria-label="Refresh">
          <Icon name="refresh" className={syncing ? 'spin' : ''} />
        </button>
        <div className="dropdown" ref={menuRef}>
          <button className="driver-bar-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu"><Icon name="menu" /></button>
          {menuOpen && (
            <div className="dropdown-menu settings-pop">
              <AppearanceControls />
              <div className="dropdown-sep" style={{ margin: '0.75rem 0 0.4rem' }} />
              {install && <button className="dropdown-item" onClick={() => { void install(); setMenuOpen(false); }}><Icon name="plus" /> Install app</button>}
              <button className="dropdown-item" onClick={() => {
                if (pending > 0 && !confirm(`${pending} updates have not been sent yet and will be lost. Log out anyway?`)) return;
                onLogout();
              }}><Icon name="logout" /> Log out</button>
            </div>
          )}
        </div>
      </header>

      <div className={`sync-strip${!online ? ' offline' : pending ? ' pending' : ''}`}>
        <Icon name={!online ? 'cloudOff' : pending ? 'clock' : 'checkCircle'} size={15} />
        {!online
          ? <span>Offline. {pending ? `${pending} update${pending > 1 ? 's' : ''} saved on this phone, sending when you are back online.` : 'Your stops are saved on this phone.'}</span>
          : pending
            ? <span>Sending {pending} update{pending > 1 ? 's' : ''}…</span>
            : <span>Up to date{syncedAt && ` · ${fmtTime(syncedAt)}`}</span>}
      </div>

      <main className="driver-main">
        {notices.map((n, i) => (
          <div key={i} className="alert alert-warning flex items-center justify-between gap-2">
            <span>{n}</span>
            <button className="modal-close" onClick={() => setNotices((all) => all.filter((_, j) => j !== i))} aria-label="Dismiss"><Icon name="close" /></button>
          </div>
        ))}
        {stale && <div className="alert alert-warning">This is the route for {fmtDay(route!.route_date)}. Connect to load today.</div>}

        {!route ? (
          <div className="driver-empty card card-pad">
            <Icon name="routes" size={36} />
            <h2>No route today</h2>
            <p>{syncedAt || online ? 'Your dispatcher has not planned a route for you yet. Tap refresh above to check again.' : 'Connect to the internet to load your route.'}</p>
          </div>
        ) : (
          <>
            <div className="driver-progress card">
              <div>
                <div className="stat-val">{done.length}<span className="text-muted" style={{ fontSize: '0.6em' }}> / {total}</span></div>
                <div className="stat-lbl">stops done</div>
              </div>
              <div className="progress grow"><div className="progress-fill" style={{ width: `${total ? (done.length / total) * 100 : 0}%` }} /></div>
            </div>

            {route.status === 'completed' && (
              <div className="dash-allclear mb-3"><Icon name="checkCircle" /> Route complete. Well done.</div>
            )}

            {upcoming.map((s) => (
              <StopCard
                key={s.id}
                stop={s}
                route={route}
                isNext={s.id === next?.id}
                confirming={confirmSkip?.id === s.id}
                onAction={(a) => tap(s, a)}
                onCancelSkip={() => setConfirmSkip(null)}
              />
            ))}

            {done.length > 0 && (
              <details className="done-list">
                <summary>Completed ({done.length})</summary>
                {done.map((s) => (
                  <div key={s.id} className="done-row">
                    <span className="stop-seq">{s.sequence_number}</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="truncate">{s.address}</div>
                      <div className="text-xs text-muted">{s.stop_type === 'pickup' ? 'Pickup' : 'Dropoff'} · {s.customer_name}{s.completed_at && ` · ${fmtTime(s.completed_at)}`}</div>
                    </div>
                    <StopBadge status={s.status} />
                  </div>
                ))}
              </details>
            )}
          </>
        )}
      </main>
    </>
  );
}

function StopCard({ stop, route, isNext, confirming, onAction, onCancelSkip }: {
  stop: RouteStop; route: Route; isNext: boolean; confirming: boolean;
  onAction: (a: DriverAction) => void; onCancelSkip: () => void;
}) {
  const actions = availableActions(route, stop);
  const [primary, ...secondary] = actions.filter((a) => a !== 'skip');
  const waiting = actions.length === 0 && stop.stop_type === 'dropoff';

  return (
    <article className={`stop-card ${stop.stop_type}${isNext ? ' next' : ''}`}>
      <div className="stop-card-head">
        <span className="stop-seq">{stop.sequence_number}</span>
        <span className={`stop-kind ${stop.stop_type}`}><Icon name={stop.stop_type} size={14} />{stop.stop_type === 'pickup' ? 'Pickup' : 'Dropoff'}</span>
        {isNext && <span className="badge badge-brand">Next</span>}
        {stop.status === 'arrived' && <StopBadge status="arrived" />}
        {stop.order_status === 'en_route' && stop.stop_type === 'dropoff' && <span className="badge badge-info">On the way</span>}
        <span className="ml-auto text-xs text-muted mono">#{stop.order_id}</span>
      </div>
      <div className="stop-card-address">{stop.address}</div>
      <div className="stop-card-customer">{stop.customer_name} · <span className="mono">{fmtPhone(stop.customer_phone)}</span></div>

      <div className="stop-card-links">
        <a className="btn btn-ghost" href={`tel:${stop.customer_phone}`}><Icon name="phone" /> Call</a>
        <a className="btn btn-ghost" href={mapsUrl(stop.location, stop.address)} target="_blank" rel="noreferrer"><Icon name="navigate" /> Navigate</a>
      </div>

      {waiting && <div className="stop-card-wait">Pick up this order first.</div>}

      {confirming ? (
        <div className="skip-confirm">
          <p>{stop.stop_type === 'pickup'
            ? 'The order goes back to your dispatcher to plan again.'
            : 'Keep the package. Your dispatcher will follow up with the customer.'}</p>
          <div className="flex gap-2">
            <button className="btn btn-ghost btn-lg grow" onClick={onCancelSkip}>Go back</button>
            <button className="btn btn-danger btn-lg grow" onClick={() => onAction('skip')}>{ACTION_LABEL.skip(stop)}</button>
          </div>
        </div>
      ) : actions.length > 0 && (
        <div className="stop-card-actions">
          {/* Only the next stop gets the big button, so a driver does not
              tick off the wrong stop with a thumb. Others stay available. */}
          {primary && (
            <button
              className={`btn btn-block ${isNext ? `btn-lg ${primary === 'complete' ? 'btn-success' : 'btn-primary'}` : 'btn-ghost'}`}
              onClick={() => onAction(primary)}
            >
              <Icon name={primary === 'complete' ? 'check' : primary === 'start' ? 'play' : 'dropoff'} /> {ACTION_LABEL[primary](stop)}
            </button>
          )}
          {isNext && (
            <div className="stop-card-secondary">
              {secondary.map((a) => (
                <button key={a} className="btn btn-ghost" onClick={() => onAction(a)}>{ACTION_LABEL[a](stop)}</button>
              ))}
              {actions.includes('skip') && <button className="btn btn-ghost text-danger" onClick={() => onAction('skip')}>{ACTION_LABEL.skip(stop)}</button>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
