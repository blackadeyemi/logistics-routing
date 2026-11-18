import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorAlert, OrderBadge, SkeletonRows } from '../components/ui';
import { staffApi } from '../lib/api';
import { fmtDateTime, fmtPhone } from '../lib/format';
import type { Order } from '../lib/types';
import { useLoad } from '../lib/useLoad';
import { OrderForm } from './OrderForm';
import { OrderIntake } from './OrderIntake';

const TABS = [
  { key: 'active', label: 'Active', status: 'pending,assigned,picked_up,en_route' },
  { key: 'pending', label: 'Unassigned', status: 'pending' },
  { key: 'assigned', label: 'Assigned', status: 'assigned' },
  { key: 'transit', label: 'In transit', status: 'picked_up,en_route' },
  { key: 'delivered', label: 'Delivered', status: 'delivered' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
  { key: 'all', label: 'All', status: '' },
];

export function Orders() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabKey = TABS.find((t) => t.key === params.get('status'))?.key ?? 'active';
  const tab = TABS.find((t) => t.key === tabKey)!;
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const creating = params.get('new') === '1';
  const intake = params.get('new') === 'whatsapp';

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const { data, error, loading, reload } = useLoad(
    () => staffApi<Order[]>('/orders', { query: { status: tab.status, q: debounced, limit: 200 } }),
    [tab.status, debounced],
  );

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Orders</h1>
          <p>Every delivery job, from the customer’s call to the doorstep.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={() => setParam('new', 'whatsapp')}><Icon name="message" /> From WhatsApp</button>
          <button className="btn btn-primary" onClick={() => setParam('new', '1')}><Icon name="plus" /> New order</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="pill-tabs">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={`pill-tab${t.key === tabKey ? ' active' : ''}`} onClick={() => setParam('status', t.key === 'active' ? null : t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="search-box toolbar-search">
          <Icon name="search" />
          <input className="form-control" placeholder="Search name, phone or address" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <ErrorAlert error={error} />

      <div className="card">
        {loading && !data ? <SkeletonRows rows={6} /> : data && data.length === 0 ? (
          <EmptyState title={debounced ? 'No orders match your search' : `No ${tab.label.toLowerCase()} orders`}>
            {tabKey === 'pending' ? 'Every order is on a route.' : 'New orders show up here as soon as they are created.'}
          </EmptyState>
        ) : data && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>Customer</th><th>Pickup</th><th>Dropoff</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {data.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => navigate(`/orders/${o.id}`)}>
                    <td className="mono text-muted">{o.id}</td>
                    <td>
                      <div className="fw-600">{o.customer_name}</div>
                      <div className="text-xs text-muted mono">{fmtPhone(o.customer_phone)}</div>
                    </td>
                    <td className="cell-address">{o.pickup_address}</td>
                    <td className="cell-address">{o.dropoff_address}</td>
                    <td><OrderBadge status={o.status} /></td>
                    <td className="text-muted text-sm" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {intake && (
        <OrderIntake
          onClose={() => setParam('new', null)}
          onSaved={(o) => { setParam('new', null); void reload(); navigate(`/orders/${o.id}`); }}
        />
      )}
      {creating && (
        <OrderForm
          onClose={() => setParam('new', null)}
          onSaved={(o) => { setParam('new', null); void reload(); navigate(`/orders/${o.id}`); }}
        />
      )}
    </>
  );
}
