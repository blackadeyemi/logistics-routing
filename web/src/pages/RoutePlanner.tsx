import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { StopsMap, useMapsEnabled, type MapPoint } from '../components/maps';
import { ErrorAlert, Modal, RouteBadge, SkeletonRows, StopBadge } from '../components/ui';
import { ApiError, conflictMessages, staffApi } from '../lib/api';
import { fmtDay, fmtPhone, fmtTime, pathKm } from '../lib/format';
import type { LatLng, Order, Route, RouteStop, StopStatus, StopType } from '../lib/types';
import { useLoad } from '../lib/useLoad';

// One row of the plan being edited.
interface DraftStop {
  stopId: number;
  orderId: number;
  type: StopType;
  address: string;
  location: LatLng | null;
  status: StopStatus;
  customer: string;
  phone: string;
  completedAt: string | null;
}

// An order that can be added: either unassigned, or taken off this route
// during this edit.
interface PoolOrder {
  id: number;
  customer: string;
  pickup: DraftStop;
  dropoff: DraftStop;
}

function fromRouteStop(s: RouteStop): DraftStop {
  return {
    stopId: s.id, orderId: s.order_id, type: s.stop_type, address: s.address, location: s.location,
    status: s.status, customer: s.customer_name, phone: s.customer_phone, completedAt: s.completed_at,
  };
}

function fromOrder(o: Order): PoolOrder {
  const base = { orderId: o.id, status: 'pending' as const, customer: o.customer_name, phone: o.customer_phone, completedAt: null };
  return {
    id: o.id,
    customer: o.customer_name,
    pickup: { ...base, stopId: o.pickup_stop_id, type: 'pickup', address: o.pickup_address, location: o.pickup_location },
    dropoff: { ...base, stopId: o.dropoff_stop_id, type: 'dropoff', address: o.dropoff_address, location: o.dropoff_location },
  };
}

const locked = (s: DraftStop) => s.status !== 'pending';

export function RoutePlanner() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad(async () => {
    const [route, pending] = await Promise.all([
      staffApi<Route>(`/routes/${id}`),
      staffApi<Order[]>('/orders', { query: { status: 'pending', limit: 200 } }),
    ]);
    return { route, pending };
  }, [id]);

  const [draft, setDraft] = useState<DraftStop[]>([]);
  const [saveError, setSaveError] = useState<{ message: string; list: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [q, setQ] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const maps = useMapsEnabled();

  useEffect(() => {
    if (data) setDraft(data.route.stops.map(fromRouteStop));
  }, [data]);

  const original = useMemo(() => data?.route.stops.map((s) => s.id).join(',') ?? '', [data]);
  const dirty = draft.map((s) => s.stopId).join(',') !== original;

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Pool: unassigned orders plus orders removed from this route in this edit.
  const pool = useMemo(() => {
    if (!data) return [];
    const inDraft = new Set(draft.map((s) => s.orderId));
    const removed = new Map<number, PoolOrder>();
    for (const s of data.route.stops.map(fromRouteStop)) {
      if (inDraft.has(s.orderId)) continue;
      const entry = removed.get(s.orderId) ?? { id: s.orderId, customer: s.customer } as PoolOrder;
      entry[s.type] = s;
      removed.set(s.orderId, entry);
    }
    const all = [...removed.values(), ...data.pending.map(fromOrder)].filter((o) => !inDraft.has(o.id) && o.pickup && o.dropoff);
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((o) => `${o.customer} ${o.pickup.address} ${o.dropoff.address}`.toLowerCase().includes(needle)) : all;
  }, [data, draft, q]);

  // Each dropoff must come after its pickup.
  const warnings = useMemo(() => {
    const pos = new Map<string, number>();
    draft.forEach((s, i) => pos.set(`${s.orderId}:${s.type}`, i));
    const bad = new Set<number>();
    for (const s of draft) {
      if (s.type === 'dropoff' && (pos.get(`${s.orderId}:pickup`) ?? -1) > (pos.get(`${s.orderId}:dropoff`) ?? 0)) bad.add(s.stopId);
    }
    return bad;
  }, [draft]);

  const km = pathKm(draft.map((s) => s.location));
  const missingCoords = draft.filter((s) => !s.location).length;

  const add = (o: PoolOrder) => setDraft((d) => [...d, o.pickup, o.dropoff]);
  const addAll = () => setDraft((d) => [...d, ...pool.flatMap((o) => [o.pickup, o.dropoff])]);
  const removeOrder = (orderId: number) => setDraft((d) => d.filter((s) => s.orderId !== orderId));
  const move = (from: number, to: number) => setDraft((d) => {
    if (to < 0 || to >= d.length || from === to) return d;
    const next = [...d];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
  });
  const pickupsFirst = () => setDraft((d) => [
    ...d.filter(locked),
    ...d.filter((s) => !locked(s) && s.type === 'pickup'),
    ...d.filter((s) => !locked(s) && s.type === 'dropoff'),
  ]);
  const pairUp = () => setDraft((d) => {
    const done = d.filter(locked);
    const rest = d.filter((s) => !locked(s));
    const out: DraftStop[] = [];
    for (const s of rest) {
      if (s.type === 'pickup') {
        out.push(s);
        const drop = rest.find((x) => x.orderId === s.orderId && x.type === 'dropoff');
        if (drop) out.push(drop);
      } else if (!rest.some((x) => x.orderId === s.orderId && x.type === 'pickup')) {
        out.push(s);
      }
    }
    return [...done, ...out];
  });

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await staffApi<Route>(`/routes/${id}/stops`, { method: 'PUT', body: { stop_ids: draft.map((s) => s.stopId) } });
      setSavedAt(new Date());
      await reload();
    } catch (err) {
      setSaveError({ message: err instanceof ApiError ? err.message : 'Could not save', list: conflictMessages(err) });
    } finally {
      setSaving(false);
    }
  };

  const deleteRoute = async () => {
    try {
      await staffApi(`/routes/${id}`, { method: 'DELETE' });
      navigate('/routes');
    } catch (err) {
      setConfirmDelete(false);
      setSaveError({ message: err instanceof ApiError ? err.message : 'Could not delete', list: [] });
    }
  };

  if (loading && !data) return <div className="card"><SkeletonRows rows={8} /></div>;
  if (!data) return <ErrorAlert error={error ?? 'Route not found'} />;
  const { route } = data;
  const started = route.stops.some((s) => s.status !== 'pending');

  return (
    <>
      <div className="page-head">
        <div>
          <p className="text-sm"><Link to={`/routes?date=${route.route_date}`}>Routes</Link> / {fmtDay(route.route_date)}</p>
          <h1 className="flex items-center gap-2">{route.driver?.name ?? 'No driver'} <RouteBadge status={route.status} /></h1>
          <p>
            {route.vehicle ? `${route.vehicle.plate_number} · ${route.vehicle.type}` : 'No vehicle'}
            {route.driver && <> · <a href={`tel:${route.driver.phone}`} className="mono">{fmtPhone(route.driver.phone)}</a></>}
          </p>
        </div>
        <div className="page-actions">
          {!started && <button className="btn btn-ghost text-danger" onClick={() => setConfirmDelete(true)}><Icon name="trash" /> Delete</button>}
          {dirty && <button className="btn btn-ghost" onClick={() => setDraft(route.stops.map(fromRouteStop))}>Discard changes</button>}
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving || warnings.size > 0}>
            <Icon name="check" /> {saving ? 'Saving…' : 'Save route'}
          </button>
        </div>
      </div>

      {saveError && <ErrorAlert error={saveError.message} extra={saveError.list} />}
      {!dirty && savedAt && <div className="alert alert-success">Saved at {fmtTime(savedAt.toISOString())}. The driver sees the new order next time the app refreshes.</div>}

      <div className="planner">
        <section className="card planner-pool">
          <div className="card-head">
            <div>
              <h2 className="card-title">Unassigned orders</h2>
              <p className="card-sub">{pool.length} waiting · adding an order adds its pickup and dropoff</p>
            </div>
            {pool.length > 1 && <button className="btn btn-ghost btn-sm" onClick={addAll}>Add all</button>}
          </div>
          <div className="planner-search search-box">
            <Icon name="search" />
            <input className="form-control" placeholder="Filter by name or area" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ul className="pool-list">
            {pool.length === 0 && <li className="pool-empty">{q ? 'No orders match.' : 'Nothing waiting. Every order is on a route.'}</li>}
            {pool.map((o) => (
              <li key={o.id} className="pool-item">
                <div className="grow">
                  <div className="flex items-center gap-2"><span className="mono text-xs text-muted">#{o.id}</span><span className="fw-600 truncate">{o.customer}</span></div>
                  <div className="pool-leg"><Icon name="pickup" size={13} /><span className="truncate">{o.pickup.address}</span></div>
                  <div className="pool-leg"><Icon name="dropoff" size={13} /><span className="truncate">{o.dropoff.address}</span></div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => add(o)} aria-label={`Add order ${o.id}`}><Icon name="plus" /> Add</button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card planner-route">
          <div className="card-head">
            <div>
              <h2 className="card-title">Stops in order {dirty && <span className="badge badge-warning" style={{ marginLeft: 6 }}>Unsaved</span>}</h2>
              <p className="card-sub">
                {draft.length} stops{km !== null && ` · about ${km.toFixed(1)} km straight line`}
                {missingCoords > 0 && ` · ${missingCoords} without coordinates`}
              </p>
            </div>
            {draft.length > 2 && (
              <div className="flex gap-2">
                <button className="btn btn-ghost btn-sm" onClick={pickupsFirst} title="All pickups, then all dropoffs">Pickups first</button>
                <button className="btn btn-ghost btn-sm" onClick={pairUp} title="Each pickup followed by its dropoff">Pair up</button>
              </div>
            )}
          </div>
          {warnings.size > 0 && <div className="alert alert-warning planner-alert">A dropoff is before its pickup. Move it down, or use Pair up.</div>}
          {draft.length === 0 ? (
            <div className="pool-empty" style={{ padding: '3rem 1rem' }}>Add orders from the left to build this route.</div>
          ) : (
            <ol className="stop-list">
              {draft.map((s, i) => (
                <li
                  key={s.stopId}
                  className={`stop-row ${s.type}${locked(s) ? ' locked' : ''}${warnings.has(s.stopId) ? ' warn' : ''}${dragIndex === i ? ' dragging' : ''}`}
                  draggable={!locked(s)}
                  onDragStart={() => setDragIndex(i)}
                  onDragEnd={() => setDragIndex(null)}
                  onDragOver={(e) => { e.preventDefault(); if (dragIndex !== null && dragIndex !== i) { move(dragIndex, i); setDragIndex(i); } }}
                >
                  <span className="stop-seq">{i + 1}</span>
                  <span className={`stop-kind ${s.type}`}><Icon name={s.type} size={14} />{s.type === 'pickup' ? 'Pickup' : 'Dropoff'}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate">{s.address}</div>
                    <div className="text-xs text-muted truncate">
                      <Link to={`/orders/${s.orderId}`} onClick={(e) => dirty && !confirm('Leave without saving?') && e.preventDefault()}>#{s.orderId}</Link> · {s.customer}
                      {warnings.has(s.stopId) && <span className="text-warning fw-600"> · before its pickup</span>}
                    </div>
                  </div>
                  {locked(s) ? (
                    <span className="flex items-center gap-2"><StopBadge status={s.status} />{s.completedAt && <span className="text-xs text-muted mono">{fmtTime(s.completedAt)}</span>}</span>
                  ) : (
                    <span className="stop-actions">
                      <button className="btn btn-ghost btn-icon" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up"><Icon name="up" size={16} /></button>
                      <button className="btn btn-ghost btn-icon" onClick={() => move(i, i + 1)} disabled={i === draft.length - 1} aria-label="Move down"><Icon name="down" size={16} /></button>
                      {!draft.some((x) => x.orderId === s.orderId && locked(x)) && (
                        <button className="btn btn-ghost btn-icon" onClick={() => removeOrder(s.orderId)} aria-label="Remove order from route" title="Remove this order (both stops)"><Icon name="close" size={16} /></button>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="card planner-sketch">
          <div className="card-head">
            <div>
              <h2 className="card-title">{maps ? 'Route map' : 'Route sketch'}</h2>
              <p className="card-sub">Stops joined in visiting order by straight lines. Not road distance.</p>
            </div>
          </div>
          {maps ? <RouteMap stops={draft} warnings={warnings} /> : <RouteSketch stops={draft} warnings={warnings} />}
        </section>
      </div>

      {confirmDelete && (
        <Modal title="Delete this route?" onClose={() => setConfirmDelete(false)} footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
          <button className="btn btn-danger" onClick={deleteRoute}>Delete route</button>
        </>}>
          <p className="mb-0">Its {route.stops.length / 2} orders go back to Unassigned.</p>
        </Modal>
      )}
    </>
  );
}

function RouteMap({ stops, warnings }: { stops: DraftStop[]; warnings: Set<number> }) {
  const points: MapPoint[] = stops.flatMap((s, i) => s.location ? [{
    id: s.stopId, location: s.location, kind: s.type, label: String(i + 1),
    title: `${i + 1}. ${s.type} · ${s.customer} · ${s.address}`,
    tone: warnings.has(s.stopId) ? 'warn' as const : locked(s) ? 'done' as const : undefined,
  }] : []);
  if (!points.length) return <div className="pool-empty" style={{ padding: '2.5rem 1rem' }}>Add stops with coordinates to see them on the map.</div>;
  return <StopsMap points={points} height={380} className="planner-map" />;
}

// Fallback when Google Maps is not configured. A to-scale sketch of the stops: enough for a dispatcher to spot a route
// that zigzags across the Third Mainland Bridge twice.
function RouteSketch({ stops, warnings }: { stops: DraftStop[]; warnings: Set<number> }) {
  const pts = stops.map((s, i) => ({ s, i })).filter((p) => p.s.location);
  if (pts.length < 2) return <div className="pool-empty" style={{ padding: '2.5rem 1rem' }}>Needs at least two stops with coordinates.</div>;
  const W = 520, H = 340, pad = 28;
  const lats = pts.map((p) => p.s.location!.lat);
  const lngs = pts.map((p) => p.s.location!.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  // Keep the aspect ratio: one degree of longitude is about cos(lat) of a degree of latitude.
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 0.005);
  const spanY = Math.max(maxLat - minLat, 0.005);
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const base = (l: LatLng) => [offX + (l.lng - minLng) * kx * scale, H - offY - (l.lat - minLat) * scale] as const;
  // Stops at the same place (two pickups at one mall) would hide each other:
  // fan repeats out in a small ring around the shared point.
  const seen = new Map<string, number>();
  const placed = new Map<number, readonly [number, number]>();
  for (const { s } of pts) {
    const [x, y] = base(s.location!);
    const key = `${Math.round(x / 8)}:${Math.round(y / 8)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const angle = (n * Math.PI) / 3 - Math.PI / 2;
    placed.set(s.stopId, n === 0 ? [x, y] : [x + 22 * Math.cos(angle), y + 22 * Math.sin(angle)]);
  }
  const xy = (s: DraftStop) => placed.get(s.stopId)!;
  const line = pts.map((p) => xy(p.s).join(',')).join(' ');
  return (
    <svg className="sketch" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sketch of the route">
      <defs>
        <linearGradient id="sketch-line" x1="0" x2="1"><stop offset="0" stopColor="var(--grad-a)" /><stop offset="1" stopColor="var(--grad-b)" /></linearGradient>
      </defs>
      <polyline points={line} fill="none" stroke="url(#sketch-line)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" opacity=".85" />
      {pts.map(({ s, i }) => {
        const [x, y] = xy(s);
        return (
          <g key={s.stopId} className={`sketch-pt ${s.type}${warnings.has(s.stopId) ? ' warn' : ''}${locked(s) ? ' done' : ''}`}>
            <circle cx={x} cy={y} r="11" />
            <text x={x} y={y} dy="0.35em" textAnchor="middle">{i + 1}</text>
            <title>{`${i + 1}. ${s.type} · ${s.address}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
