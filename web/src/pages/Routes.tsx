import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorAlert, Field, Modal, RouteBadge, SkeletonRows } from '../components/ui';
import { ApiError, staffApi } from '../lib/api';
import { fmtDay, fmtPhone, shiftDate, todayLagos } from '../lib/format';
import type { Driver, Route, RouteSummary, Vehicle } from '../lib/types';
import { useLoad } from '../lib/useLoad';
import { Progress } from './Dashboard';

export function RoutesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const today = todayLagos();
  const date = params.get('date') ?? today;
  const [creating, setCreating] = useState<Driver | true | null>(null);

  const { data, error, loading } = useLoad(async () => {
    const [routes, drivers] = await Promise.all([
      staffApi<RouteSummary[]>('/routes', { query: { date } }),
      staffApi<Driver[]>('/drivers', { query: { status: 'active' } }),
    ]);
    return { routes, drivers };
  }, [date]);

  const setDate = (d: string) => setParams(d === today ? {} : { date: d }, { replace: true });
  const busy = new Set(data?.routes.map((r) => r.driver_id));
  const free = data?.drivers.filter((d) => !busy.has(d.id)) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Routes</h1>
          <p>One route per driver per day. Build it by hand, in the order the driver should go.</p>
        </div>
        <div className="page-actions">
          <div className="date-nav">
            <button className="btn btn-ghost btn-icon" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day"><Icon name="left" /></button>
            <input type="date" className="form-control" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <button className="btn btn-ghost btn-icon" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day"><Icon name="right" /></button>
            {date !== today && <button className="btn btn-ghost btn-sm" onClick={() => setDate(today)}>Today</button>}
          </div>
          <Link className="btn btn-ghost" to={`/routes/optimize?date=${date}`}><Icon name="sparkle" /> Optimize day</Link>
          <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!free.length}><Icon name="plus" /> New route</button>
        </div>
      </div>

      <ErrorAlert error={error} />

      <p className="text-sm text-muted mb-3">{fmtDay(date)}{date === today && ' · today'}</p>

      {loading && !data ? <div className="card"><SkeletonRows /></div> : data && (
        <>
          {data.routes.length === 0 ? (
            <div className="card"><EmptyState title="No routes for this day">Pick a driver below to start one.</EmptyState></div>
          ) : (
            <div className="route-grid">
              {data.routes.map((r) => (
                <Link key={r.id} to={`/routes/${r.id}`} className="card route-card">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 grow">
                      <span className="avatar">{r.driver?.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>
                      <div className="grow">
                        <div className="fw-600 truncate">{r.driver?.name ?? 'No driver'}</div>
                        <div className="text-xs text-muted">{r.vehicle ? `${r.vehicle.plate_number} · ${r.vehicle.type}` : 'No vehicle'}</div>
                      </div>
                    </div>
                    <RouteBadge status={r.status} />
                  </div>
                  <Progress done={r.done_count ?? 0} total={r.stop_count ?? 0} />
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">{r.stop_count ? `${r.done_count} of ${r.stop_count} stops done` : 'No stops yet'}</span>
                    <span className="fw-600" style={{ color: 'var(--brand)' }}>{r.status === 'planned' ? 'Plan' : 'Open'} <Icon name="arrowRight" size={14} /></span>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {free.length > 0 && (
            <section className="dash-section mt-3">
              <div className="dash-section-head"><h2>Drivers without a route</h2></div>
              <div className="chip-list">
                {free.map((d) => (
                  <button key={d.id} type="button" className="driver-chip" onClick={() => setCreating(d)}>
                    <span className="avatar">{d.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>
                    <span>
                      <span className="fw-600">{d.name}</span>
                      <span className="text-xs text-muted">{d.vehicle ? d.vehicle.plate_number : fmtPhone(d.phone)}</span>
                    </span>
                    <Icon name="plus" size={16} />
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {creating && data && (
        <NewRoute
          date={date}
          drivers={free}
          initial={creating === true ? undefined : creating}
          onClose={() => setCreating(null)}
          onCreated={(r) => navigate(`/routes/${r.id}`)}
        />
      )}
    </>
  );
}

function NewRoute({ date, drivers, initial, onClose, onCreated }: {
  date: string; drivers: Driver[]; initial?: Driver; onClose: () => void; onCreated: (r: Route) => void;
}) {
  const [driverId, setDriverId] = useState<number | ''>(initial?.id ?? '');
  const [vehicleId, setVehicleId] = useState<number | '' | 'driver'>('driver');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: vehicles } = useLoad(() => staffApi<Vehicle[]>('/vehicles', { query: { status: 'active' } }), []);
  const driver = drivers.find((d) => d.id === driverId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!driverId) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { driver_id: driverId, route_date: date };
      if (vehicleId !== 'driver') body.vehicle_id = vehicleId === '' ? null : vehicleId;
      onCreated(await staffApi<Route>('/routes', { method: 'POST', body }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the route');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`New route for ${fmtDay(date)}`}
      onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form="new-route" className="btn btn-primary" disabled={!driverId || busy}>Create and plan</button>
      </>}
    >
      <form id="new-route" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Driver">
          <select className="form-control" value={driverId} onChange={(e) => setDriverId(e.target.value ? Number(e.target.value) : '')} required autoFocus>
            <option value="">Choose a driver</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.vehicle ? ` · ${d.vehicle.plate_number}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Vehicle" hint="Defaults to the vehicle assigned to the driver.">
          <select className="form-control" value={vehicleId} onChange={(e) => setVehicleId(e.target.value === 'driver' ? 'driver' : e.target.value ? Number(e.target.value) : '')}>
            <option value="driver">{driver?.vehicle ? `Driver's vehicle (${driver.vehicle.plate_number})` : "Driver's vehicle (none assigned)"}</option>
            {vehicles?.map((v) => <option key={v.id} value={v.id}>{v.plate_number} · {v.type}{v.capacity_kg ? ` · ${v.capacity_kg} kg` : ''}</option>)}
            <option value="">No vehicle</option>
          </select>
        </Field>
      </form>
    </Modal>
  );
}
