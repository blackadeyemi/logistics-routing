import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge, ErrorAlert, Modal } from '../components/ui';
import { ApiError, staffApi } from '../lib/api';
import { fmtDay, todayLagos } from '../lib/format';
import type { OptimizationRun, RouteSummary } from '../lib/types';
import { useLoad } from '../lib/useLoad';

/**
 * Runs the route optimizer for a day and shows its plan next to the
 * current (manual) one. Nothing changes until the dispatcher accepts;
 * after that each route can still be edited in the planner.
 */
export function Optimize() {
  const [params] = useSearchParams();
  const date = params.get('date') || todayLagos();
  const [run, setRun] = useState<OptimizationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const { data: current } = useLoad(() => staffApi<RouteSummary[]>('/routes', { query: { date } }), [date]);
  const toggleKeep = (driverId: number) => setKeep((k) => {
    const next = new Set(k);
    if (next.has(driverId)) next.delete(driverId); else next.add(driverId);
    return next;
  });

  const optimize = async () => {
    setBusy(true);
    setError(null);
    try {
      setRun(await staffApi<OptimizationRun>('/optimizations', { method: 'POST', body: { route_date: date, keep_driver_ids: [...keep] } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The optimizer failed');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (what: 'accept' | 'discard') => {
    if (!run) return;
    setDeciding(true);
    setError(null);
    try {
      setRun(await staffApi<OptimizationRun>(`/optimizations/${run.id}/${what}`, { method: 'POST' }));
      setConfirm(false);
      window.dispatchEvent(new CustomEvent('data:changed'));
    } catch (err) {
      setConfirm(false);
      setError(err instanceof ApiError ? err.message : 'Could not apply the plan');
      if (err instanceof ApiError && (err.details as { code?: string } | undefined)?.code === 'stale') setRun({ ...run, status: 'stale' });
    } finally {
      setDeciding(false);
    }
  };

  const s = run?.manual.summary;
  const saving = s && s.manual.km > 0 ? 1 - s.proposed.km_for_manual_orders / s.manual.km : null;
  const manualBy = new Map((run?.manual.routes ?? []).map((r) => [r.driver_id, r]));
  const drivers = run ? [...new Set([...run.manual.routes.map((r) => r.driver_id), ...run.proposed.map((r) => r.driver_id)])] : [];

  return (
    <>
      <div className="page-head">
        <div>
          <p className="text-sm"><Link to={`/routes?date=${date}`}>Routes</Link> / {fmtDay(date)}</p>
          <h1>Optimize the day</h1>
          <p>Re-plans unassigned orders and routes that have not started, across drivers with a vehicle. Respects capacity, pickup before dropoff and delivery windows. Started routes are left alone.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={optimize} disabled={busy}>
            <Icon name="sparkle" /> {busy ? 'Optimizing… about 5 seconds' : run ? 'Run again' : 'Run optimizer'}
          </button>
        </div>
      </div>
      <ErrorAlert error={error} />

      {!run && !busy && (
        <div className="card card-pad optimize-intro">
          <p>The optimizer proposes routes that cover the same orders with less driving, and shows them next to the current plan. You decide whether to apply them, and you can still adjust any route in the planner afterwards.</p>
          {current && current.length > 0 && (
            <>
              <div className="form-section">Current routes</div>
              <ul className="keep-list">
                {current.map((r) => {
                  const started = r.status !== 'planned' || (r.done_count ?? 0) > 0;
                  return (
                    <li key={r.id}>
                      <label className={started ? 'text-muted' : ''}>
                        <input type="checkbox" checked={started || (r.driver_id !== null && keep.has(r.driver_id))} disabled={started || r.driver_id === null}
                          onChange={() => r.driver_id !== null && toggleKeep(r.driver_id)} />
                        <span><strong>{r.driver?.name ?? 'No driver'}</strong> · {r.stop_count} stops</span>
                        <span className="text-xs text-muted">{started ? 'started, always kept' : 'keep as it is'}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
      {busy && <div className="card card-pad"><div className="optimize-busy"><Icon name="refresh" /> Searching for shorter routes…</div></div>}

      {run && s && (
        <>
          <div className="stat-flex">
            <div className="stat-card"><div className="stat-val">{s.manual.km} km</div><div className="stat-lbl">Current plan</div><div className="stat-sub">{s.manual.routes} routes · {s.manual.orders} orders</div></div>
            <div className="stat-card"><div className="stat-val tone-pos">{s.proposed.km} km</div><div className="stat-lbl">Optimized plan</div><div className="stat-sub">{s.proposed.routes} routes · {s.proposed.orders} orders</div></div>
            <div className="stat-card"><div className="stat-val tone-brand">{saving !== null ? `${Math.round(saving * 100)}%` : '–'}</div><div className="stat-lbl">Less driving</div><div className="stat-sub">{saving !== null ? `for the ${s.manual.orders} orders already planned` : 'nothing planned yet to compare'}</div></div>
            <div className="stat-card"><div className="stat-val">{(run.solve_ms / 1000).toFixed(1)} s</div><div className="stat-lbl">Solve time</div><div className="stat-sub">straight-line distances</div></div>
          </div>

          {s.unplanned_orders_added > 0 && <div className="alert alert-info">The plan also places {s.unplanned_orders_added} unassigned order{s.unplanned_orders_added === 1 ? '' : 's'} that the current plan does not cover. Total km includes them; the saving compares only the orders both plans cover.</div>}
          {run.unassigned.length > 0 && (
            <div className="alert alert-warning">
              <strong>{run.unassigned.length} order{run.unassigned.length === 1 ? '' : 's'} could not be placed:</strong>
              <ul className="mb-0">{run.unassigned.map((u) => <li key={u.order_id}><Link to={`/orders/${u.order_id}`}>#{u.order_id}</Link> {u.customer}: {u.reason}</li>)}</ul>
            </div>
          )}

          <section className="card">
            <div className="card-head">
              <div><h2 className="card-title">Side by side</h2><p className="card-sub">Straight-line km from each route’s first stop to its last.</p></div>
              <RunStatus run={run} />
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Driver</th><th className="num">Current stops</th><th className="num">Current km</th><th className="num">Optimized stops</th><th className="num">Optimized km</th><th className="num">Peak load</th></tr></thead>
                <tbody>
                  {drivers.map((d) => {
                    const m = manualBy.get(d);
                    const p = run.proposed.find((r) => r.driver_id === d);
                    return (
                      <tr key={d}>
                        <td className="fw-600">{p?.driver ?? m?.driver}{p && <span className="text-xs text-muted"> · {p.vehicle}</span>}</td>
                        <td className="num">{m?.stops ?? '–'}</td>
                        <td className="num">{m ? m.distance_km : '–'}</td>
                        <td className="num">{p?.stops.length ?? '–'}</td>
                        <td className="num">{p ? p.distance_km : '–'}</td>
                        <td className="num">{p ? `${p.peak_load_kg} / ${p.capacity_kg} kg` : '–'}</td>
                      </tr>
                    );
                  })}
                  <tr className="total-row">
                    <td>Total</td>
                    <td className="num">{run.manual.routes.reduce((n, r) => n + r.stops, 0)}</td>
                    <td className="num">{s.manual.km}</td>
                    <td className="num">{run.proposed.reduce((n, r) => n + r.stops.length, 0)}</td>
                    <td className="num">{s.proposed.km}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            {run.status === 'proposed' && (
              <div className="optimize-actions">
                <button className="btn btn-primary" onClick={() => setConfirm(true)}><Icon name="check" /> Accept plan</button>
                <button className="btn btn-ghost" onClick={() => void decide('discard')} disabled={deciding}>Discard</button>
                <span className="text-xs text-muted">Accepting replaces the routes that have not started. You can adjust any route in the planner afterwards.</span>
              </div>
            )}
          </section>

          <div className="plan-grid">
            {run.proposed.map((r) => (
              <section key={r.driver_id} className="card card-pad plan-route">
                <div className="flex items-center gap-2">
                  <h3 className="card-title grow">{r.driver}</h3>
                  <span className="text-xs text-muted">{r.vehicle}</span>
                </div>
                <p className="text-xs text-muted">{r.stops.length} stops · {r.distance_km} km · peak {r.peak_load_kg} of {r.capacity_kg} kg</p>
                <ol className="plan-stops">
                  {r.stops.map((st) => (
                    <li key={st.stop_id}>
                      <span className="mono text-xs text-muted">{st.eta}</span>
                      <span className={`stop-type ${st.type}`}>{st.type}</span>
                      <span className="grow">{st.address}</span>
                      <Link className="text-xs" to={`/orders/${st.order_id}`}>#{st.order_id}</Link>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
          <p className="text-xs text-muted">Times are estimates from straight-line distance at Lagos traffic speeds plus 5 minutes per stop, starting at 08:00. Road distances come in a later phase.</p>
        </>
      )}

      {confirm && run && (
        <Modal title="Apply the optimized plan?" onClose={() => setConfirm(false)} footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Keep current routes</button>
          <button className="btn btn-primary" onClick={() => void decide('accept')} disabled={deciding}>{deciding ? 'Applying…' : 'Apply plan'}</button>
        </>}>
          <p className="mb-0">This sets {run.proposed.length} driver route{run.proposed.length === 1 ? '' : 's'} for {fmtDay(run.route_date)}. Drivers see the new stop order the next time their app refreshes.</p>
        </Modal>
      )}
    </>
  );
}

function RunStatus({ run }: { run: OptimizationRun }) {
  if (run.status === 'accepted') {
    return (
      <span className="flex items-center gap-2">
        <Badge tone="success">Applied</Badge>
        <Link className="btn btn-ghost btn-sm" to={`/routes?date=${run.route_date}`}>Open routes</Link>
      </span>
    );
  }
  if (run.status === 'discarded') return <Badge tone="muted">Discarded</Badge>;
  if (run.status === 'stale') return <Badge tone="warning">Out of date, run again</Badge>;
  return <Badge tone="warning">Not applied yet</Badge>;
}
