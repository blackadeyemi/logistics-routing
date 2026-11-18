import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { StopsMap, useMapsEnabled, type MapPoint } from '../components/maps';
import { ErrorAlert, Modal, OrderBadge, SkeletonRows } from '../components/ui';
import { ApiError, staffApi } from '../lib/api';
import { EVENT_LABEL, fmtDateTime, fmtPhone, haversineKm, mapsUrl } from '../lib/format';
import type { OrderDetail as Detail } from '../lib/types';
import { useLoad } from '../lib/useLoad';
import { OrderForm } from './OrderForm';

const EVENT_TONE: Record<string, string> = {
  delivered: 'success', picked_up: 'info', en_route: 'info', arrived: 'brand',
  assigned: 'brand', skipped: 'danger', cancelled: 'muted', unassigned: 'warning',
};

export function OrderDetail() {
  const id = Number(useParams().id);
  const { data: order, error, loading, reload } = useLoad(() => staffApi<Detail>(`/orders/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const maps = useMapsEnabled();

  const cancel = async () => {
    setActionError(null);
    try {
      await staffApi(`/orders/${id}/cancel`, { method: 'POST' });
      setConfirmCancel(false);
      void reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not cancel');
    }
  };

  if (loading && !order) return <div className="card"><SkeletonRows rows={6} /></div>;
  if (!order) return <ErrorAlert error={error ?? 'Order not found'} />;

  const km = order.pickup_location && order.dropoff_location ? haversineKm(order.pickup_location, order.dropoff_location) : null;
  const points: MapPoint[] = (['pickup', 'dropoff'] as const).flatMap((kind) => {
    const loc = kind === 'pickup' ? order.pickup_location : order.dropoff_location;
    const address = kind === 'pickup' ? order.pickup_address : order.dropoff_address;
    return loc ? [{ id: kind, kind, location: loc, label: kind === 'pickup' ? 'P' : 'D', title: `${kind}: ${address}` }] : [];
  });
  const cancellable = order.status === 'pending' || order.status === 'assigned';

  return (
    <>
      <div className="page-head">
        <div>
          <p className="text-sm"><Link to="/orders">Orders</Link> / #{order.id}</p>
          <h1 className="flex items-center gap-2">{order.customer_name} <OrderBadge status={order.status} /></h1>
          <p>Created {fmtDateTime(order.created_at)}{km !== null && ` · ${km.toFixed(1)} km straight line`}</p>
        </div>
        <div className="page-actions">
          {order.route_id && <Link className="btn btn-ghost" to={`/routes/${order.route_id}`}><Icon name="routes" /> View route</Link>}
          {order.status === 'pending' && <Link className="btn btn-primary" to="/routes"><Icon name="routes" /> Add to a route</Link>}
          {order.status !== 'cancelled' && order.status !== 'delivered' && <button className="btn btn-ghost" onClick={() => setEditing(true)}><Icon name="edit" /> Edit</button>}
          {cancellable && <button className="btn btn-ghost text-danger" onClick={() => setConfirmCancel(true)}>Cancel order</button>}
        </div>
      </div>

      <div className="detail-grid">
        <section className="card card-pad">
          <div className="form-section">Customer</div>
          <div className="fact-row">
            <div>
              <div className="fw-600">{order.customer_name}</div>
              <div className="mono text-muted">{fmtPhone(order.customer_phone)}</div>
            </div>
            <a className="btn btn-ghost btn-sm" href={`tel:${order.customer_phone}`}><Icon name="phone" /> Call</a>
          </div>

          <div className="form-section">Journey</div>
          <ol className="journey">
            {(['pickup', 'dropoff'] as const).map((kind) => {
              const address = kind === 'pickup' ? order.pickup_address : order.dropoff_address;
              const loc = kind === 'pickup' ? order.pickup_location : order.dropoff_location;
              return (
                <li key={kind} className={`journey-stop ${kind}`}>
                  <span className="journey-dot"><Icon name={kind} /></span>
                  <div className="grow">
                    <div className="text-xs text-muted" style={{ textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>{kind}</div>
                    <div>{address}</div>
                    {loc ? <div className="text-xs text-muted mono">{loc.lat}, {loc.lng}</div> : <div className="text-xs text-warning">No coordinates yet</div>}
                  </div>
                  <a className="btn btn-ghost btn-sm" href={mapsUrl(loc, address)} target="_blank" rel="noreferrer"><Icon name="navigate" /> Map</a>
                </li>
              );
            })}
          </ol>
          {maps && points.length > 0 && <StopsMap points={points} height={260} className="detail-map" />}
        </section>

        <section className="card card-pad">
          <div className="form-section">Timeline</div>
          <ol className="timeline">
            {[...order.events].reverse().map((e) => (
              <li key={e.id} className={`timeline-item tone-${EVENT_TONE[e.event_type] ?? 'muted'}`}>
                <span className="timeline-dot" />
                <div>
                  <div className="fw-600">{EVENT_LABEL[e.event_type]}</div>
                  <div className="text-xs text-muted">
                    {fmtDateTime(e.occurred_at)} · {e.actor_type === 'driver' ? 'by the driver' : e.actor_type === 'user' ? 'by dispatch' : 'automatic'}
                    {e.actor_type === 'driver' && Math.abs(new Date(e.created_at).getTime() - new Date(e.occurred_at).getTime()) > 60_000 && ' · synced later'}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {editing && <OrderForm order={order} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload(); }} />}
      {confirmCancel && (
        <Modal
          title={`Cancel order #${order.id}?`}
          onClose={() => setConfirmCancel(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setConfirmCancel(false)}>Keep order</button>
            <button className="btn btn-danger" onClick={cancel}>Cancel order</button>
          </>}
        >
          <ErrorAlert error={actionError} />
          <p className="mb-0">{order.route_id ? 'It will be taken off its route and the driver will no longer see it.' : 'It will move to Cancelled and cannot be assigned.'}</p>
        </Modal>
      )}
    </>
  );
}
