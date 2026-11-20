import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { LiveMap, ROUTE_COLOURS, type LiveDriver } from '../components/LiveMap';
import { Badge, ErrorAlert, RouteBadge, SkeletonRows } from '../components/ui';
import { ApiError, staffApi } from '../lib/api';
import { fmtPhone, fmtTime, initials } from '../lib/format';
import { useLiveEvents, useLiveStatus, type LiveEvent } from '../lib/live';
import type { LiveDay, TrackingQuality } from '../lib/types';

const STALE_S = 5 * 60;

function ago(seconds: number) {
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/**
 * Where every driver is, what is left on their route, and when each stop
 * is due. Positions arrive over the WebSocket and move in place; stop and
 * route changes reload the day. Nobody has to refresh.
 */
export function Live() {
  const [day, setDay] = useState<LiveDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [quality, setQuality] = useState<TrackingQuality | null>(null);
  const [, setTick] = useState(0);
  const status = useLiveStatus();
  const reloadTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setDay(await staffApi<LiveDay>('/live', { quiet: true }));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the live view');
    }
  }, []);
  const loadQuality = useCallback(async () => {
    try { setQuality(await staffApi<TrackingQuality>('/live/tracking-quality', { quiet: true })); } catch { /* shown as empty */ }
  }, []);

  useEffect(() => {
    void load();
    void loadQuality();
    // "x min ago" keeps counting; quality refreshes every minute.
    const t = window.setInterval(() => { setTick((n) => n + 1); void loadQuality(); }, 60_000);
    const fast = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => { window.clearInterval(t); window.clearInterval(fast); };
  }, [load, loadQuality]);

  const lastQuality = useRef(0);
  const onEvent = useCallback((e: LiveEvent) => {
    if (e.type === 'location') {
      // Keep the tracking-quality table current without hammering it.
      if (Date.now() - lastQuality.current > 20_000) {
        lastQuality.current = Date.now();
        window.setTimeout(() => void loadQuality(), 1500);
      }
      // Move the driver and update ETAs without a round trip.
      setDay((d) => d && {
        ...d,
        routes: d.routes.map((r) => {
          if (r.route_id !== e.route_id && r.driver_id !== e.driver_id) return r;
          const etas = new Map(e.eta.map((x) => [x.stop_id, x]));
          return {
            ...r,
            location: { ...e.location, recorded_at: e.recorded_at, age_s: Math.max(0, Math.round((Date.now() - new Date(e.recorded_at).getTime()) / 1000)) },
            eta_from: 'driver',
            stops: r.stops.map((s) => (etas.has(s.stop_id) ? { ...s, eta: etas.get(s.stop_id)!.eta, eta_minutes: etas.get(s.stop_id)!.minutes } : s)),
          };
        }),
      });
      return;
    }
    if (e.type === 'hello') return;
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void load(), 400);
  }, [load, loadQuality]);
  useLiveEvents(onEvent);

  const routes = day?.routes ?? [];
  const now = Date.now();
  const drivers: LiveDriver[] = useMemo(() => routes.map((r, i) => {
    const ageS = r.location ? Math.round((now - new Date(r.location.recorded_at).getTime()) / 1000) : null;
    return {
      route_id: r.route_id,
      colour: ROUTE_COLOURS[i % ROUTE_COLOURS.length]!,
      initials: initials(r.driver ?? '?'),
      name: r.driver ?? 'No driver',
      location: r.location ? { lat: r.location.lat, lng: r.location.lng } : null,
      stale: ageS === null || ageS > STALE_S,
      stops: r.stops.map((s) => ({
        stop_id: s.stop_id, n: s.n, type: s.type, location: s.location,
        done: s.status === 'completed' || s.status === 'skipped',
        title: `${s.n}. ${s.type} · ${s.customer} · ${s.address}${s.eta ? ` · due ${fmtTime(s.eta)}` : ''}`,
      })),
    };
  // now changes every render on purpose: staleness follows the clock tick
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [routes, Math.floor(now / 15000)]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="flex items-center gap-2">Live map <LiveBadge status={status} /></h1>
          <p>Where every driver is and when each remaining stop is due. Updates by itself as drivers move and tap.</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-ghost" to="/messages"><Icon name="message" /> Customer SMS</Link>
        </div>
      </div>
      <ErrorAlert error={error} />

      {!day ? <div className="card"><SkeletonRows rows={5} /></div> : routes.length === 0 ? (
        <div className="card card-pad"><p className="mb-0">No routes today yet. Plan them on the <Link to="/routes">Routes</Link> page.</p></div>
      ) : (
        <div className="live-grid">
          <div className="live-list">
            {routes.map((r, i) => {
              const d = drivers[i]!;
              const ageS = r.location ? Math.round((now - new Date(r.location.recorded_at).getTime()) / 1000) : null;
              const remaining = r.stops.filter((s) => s.status === 'pending' || s.status === 'arrived');
              const next = remaining[0];
              const doneCount = r.stops.length - remaining.length;
              return (
                <button key={r.route_id} type="button" className={`card live-driver${focus === r.route_id ? ' focused' : ''}`} style={{ borderLeftColor: d.colour }}
                  onClick={() => setFocus((f) => (f === r.route_id ? null : r.route_id))}>
                  <div className="flex items-center gap-2">
                    <span className="avatar" style={{ background: d.colour }}>{d.initials}</span>
                    <span className="grow">
                      <strong>{r.driver ?? 'No driver'}</strong>
                      <span className="text-xs text-muted block">{r.vehicle ?? 'No vehicle'}{r.driver_phone && ` · ${fmtPhone(r.driver_phone)}`}</span>
                    </span>
                    <RouteBadge status={r.status} />
                  </div>
                  <div className="live-meta text-xs">
                    {ageS === null
                      ? <span className="text-muted">No location yet</span>
                      : <span className={ageS > STALE_S ? 'text-warning' : 'text-success'}>● Seen {ago(ageS)}</span>}
                    <span className="text-muted">{doneCount} of {r.stops.length} stops done</span>
                  </div>
                  {next ? (
                    <div className="live-next">
                      <span className={`stop-type ${next.type}`}>{next.type}</span>
                      <span className="grow truncate">{next.address}</span>
                      {next.eta && <span className="live-eta" title={r.eta_from === 'driver' ? 'From the driver’s position' : 'No recent position: from the first stop, starting now'}>{fmtTime(next.eta)}</span>}
                    </div>
                  ) : <div className="live-next text-muted">All stops done</div>}
                  {focus === r.route_id && (
                    <ol className="live-stops">
                      {r.stops.map((s) => (
                        <li key={s.stop_id} className={s.status}>
                          <span className="mono text-xs">{s.eta && (s.status === 'pending' || s.status === 'arrived') ? fmtTime(s.eta) : s.completed_at ? fmtTime(s.completed_at) : '–'}</span>
                          <span className={`stop-type ${s.type}`}>{s.type}</span>
                          <span className="grow">{s.address}</span>
                          <Link to={`/orders/${s.order_id}`} onClick={(ev) => ev.stopPropagation()}>#{s.order_id}</Link>
                        </li>
                      ))}
                    </ol>
                  )}
                </button>
              );
            })}
          </div>
          <section className="card live-map-card">
            <LiveMap drivers={drivers} focus={focus} />
            <p className="text-xs text-muted live-note">ETAs use straight-line distance at Lagos traffic speed plus 5 minutes per stop, recalculated with every position. Road distances come in a later phase.</p>
          </section>
        </div>
      )}

      <section className="card mt-3">
        <div className="card-head">
          <div>
            <h2 className="card-title">Tracking quality today</h2>
            <p className="card-sub">The app sends a position every {quality?.expected_interval_s ?? 30} s while a route is active. Phones pause web apps when the screen is off or another app is open; this shows how much that costs.</p>
          </div>
        </div>
        {!quality || quality.drivers.length === 0 ? <p className="card-pad mb-0 text-sm text-muted">No positions received today yet.</p> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Driver</th><th className="num">Points</th><th className="num">Tracked</th><th className="num">Coverage</th><th className="num">Gaps over 90 s</th><th className="num">Longest gap</th><th className="num">Gap time while app hidden</th><th className="num">Sent late from queue</th></tr></thead>
              <tbody>
                {quality.drivers.map((q) => (
                  <tr key={q.driver_id}>
                    <td className="fw-600">{q.driver}</td>
                    <td className="num">{q.points} / {q.expected_points}</td>
                    <td className="num">{q.tracked_minutes} min</td>
                    <td className="num"><Badge tone={q.coverage >= 0.9 ? 'success' : q.coverage >= 0.6 ? 'warning' : 'danger'}>{Math.round(q.coverage * 100)}%</Badge></td>
                    <td className="num">{q.gaps_over_90s}</td>
                    <td className="num">{Math.round(q.longest_gap_s / 60)} min</td>
                    <td className="num">{q.gap_minutes_while_hidden} of {q.gap_minutes} min</td>
                    <td className="num">{q.sent_late_from_queue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function LiveBadge({ status }: { status: 'connecting' | 'live' | 'offline' }) {
  if (status === 'live') return <Badge tone="success">Live</Badge>;
  if (status === 'connecting') return <Badge tone="muted">Connecting…</Badge>;
  return <Badge tone="warning">Reconnecting</Badge>;
}
