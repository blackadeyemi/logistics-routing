import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorAlert, RouteBadge, SkeletonRows } from '../components/ui';
import { staffApi } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { fmtDay } from '../lib/format';
import type { RouteSummary, TodayStats } from '../lib/types';
import { useLoad } from '../lib/useLoad';

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false }).format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function Dashboard() {
  const { user } = useStaffAuth();
  const navigate = useNavigate();
  const { data, error, loading } = useLoad(async () => {
    const [stats, routes] = await Promise.all([
      staffApi<TodayStats>('/stats/today'),
      staffApi<RouteSummary[]>('/routes'),
    ]);
    return { stats, routes };
  }, []);

  const s = data?.stats;
  const alerts = s ? [
    s.failed_today > 0 && { tone: 'danger', count: s.failed_today, label: 'Failed deliveries today', detail: 'Dropoffs the driver skipped. Call the customer.', to: '/routes' },
    s.pending > 0 && { tone: 'warn', count: s.pending, label: 'Orders not on a route', detail: 'Add them to a driver’s route.', to: '/orders?status=pending' },
    s.drivers_free > 0 && { tone: 'info', count: s.drivers_free, label: 'Drivers with no route today', detail: 'Free capacity for unassigned orders.', to: '/routes' },
    s.drivers_without_pin > 0 && { tone: 'info', count: s.drivers_without_pin, label: 'Drivers who cannot log in', detail: 'Set a PIN so they can use the app.', to: '/drivers' },
  ].filter(Boolean) as { tone: string; count: number; label: string; detail: string; to: string }[] : [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greeting()}, {user?.full_name.split(' ')[0]}</h1>
          <p>{s ? fmtDay(s.date) : 'Today'} · what is moving across Lagos right now</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-ghost" to="/orders?new=1"><Icon name="plus" /> New order</Link>
          <Link className="btn btn-primary" to="/routes"><Icon name="routes" /> Plan routes</Link>
        </div>
      </div>

      <ErrorAlert error={error} />

      <div className="stat-flex">
        <Stat value={s?.pending} label="Unassigned orders" tone="tone-warn" />
        <Stat value={s?.assigned} label="Assigned, not picked up" tone="tone-brand" />
        <Stat value={s?.in_transit} label="In transit" />
        <Stat value={s?.delivered_today} label="Delivered today" tone="tone-pos" />
        <Stat value={s?.failed_today} label="Failed today" tone={s && s.failed_today > 0 ? 'tone-neg' : ''} />
        <Stat value={s ? `${s.routes_in_progress + s.routes_completed}/${s.routes_today}` : undefined} label="Routes started" sub={s ? `${s.routes_completed} completed` : undefined} />
      </div>

      <section className="dash-section">
        <div className="dash-section-head"><h2>Needs attention</h2></div>
        {loading && !s ? <span className="skel" style={{ width: 240 }} /> : alerts.length ? (
          <div className="dash-alerts">
            {alerts.map((a) => (
              <Link key={a.label} to={a.to} className={`dash-alert tone-${a.tone}`}>
                <span className="dash-alert-count">{a.count}</span>
                <span className="dash-alert-label">{a.label}</span>
                <span className="dash-alert-detail">{a.detail}</span>
              </Link>
            ))}
          </div>
        ) : s && <div className="dash-allclear"><Icon name="checkCircle" /> All clear. Every order has a driver and nothing has failed today.</div>}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Today’s routes</h2>
            <p className="card-sub">{s ? `${s.drivers_active} active drivers, ${s.routes_today} on the road today` : ' '}</p>
          </div>
          <Link className="btn btn-ghost btn-sm" to="/routes">All routes <Icon name="arrowRight" /></Link>
        </div>
        {loading && !data ? <SkeletonRows /> : data && data.routes.length === 0 ? (
          <EmptyState title="No routes planned for today">Create a route for a driver, then add orders to it.</EmptyState>
        ) : data && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Driver</th><th>Vehicle</th><th>Status</th><th>Progress</th><th className="num">Stops</th></tr></thead>
              <tbody>
                {data.routes.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/routes/${r.id}`)}>
                    <td className="fw-600">{r.driver?.name ?? 'No driver'}</td>
                    <td className="text-muted">{r.vehicle ? `${r.vehicle.plate_number} · ${r.vehicle.type}` : '·'}</td>
                    <td><RouteBadge status={r.status} /></td>
                    <td style={{ minWidth: 160 }}><Progress done={r.done_count ?? 0} total={r.stop_count ?? 0} /></td>
                    <td className="num">{r.done_count}/{r.stop_count}</td>
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

function Stat({ value, label, tone = '', sub }: { value: number | string | undefined; label: string; tone?: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className={`stat-val ${tone}`}>{value ?? <span className="skel" style={{ width: 48, height: 26 }} />}</div>
      <div className="stat-lbl">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
