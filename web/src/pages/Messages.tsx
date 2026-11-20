import { Link } from 'react-router-dom';
import { Badge, ErrorAlert, SkeletonRows } from '../components/ui';
import { staffApi } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { fmtDateTime, fmtPhone } from '../lib/format';
import type { SmsMessage } from '../lib/types';
import { useLoad } from '../lib/useLoad';

const REASON: Record<SmsMessage['reason'], string> = { en_route: 'On the way', delivered: 'Delivered', manual: 'Sent by dispatch' };
const STATUS: Record<SmsMessage['status'], { tone: string; label: string }> = {
  sent: { tone: 'success', label: 'Sent' },
  logged: { tone: 'muted', label: 'Outbox only' },
  failed: { tone: 'danger', label: 'Failed' },
};

/** Every text customers were sent, or would be sent with SMS set up. */
export function Messages() {
  const { user } = useStaffAuth();
  const { data, error, loading } = useLoad(() => staffApi<{ provider: string; messages: SmsMessage[] }>('/sms', { query: { limit: 100 } }), []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customer SMS</h1>
          <p>Texts with a tracking link, sent when the driver sets off to the customer and when the parcel is delivered, or by hand from an order.</p>
        </div>
      </div>
      <ErrorAlert error={error} />
      {data?.provider === 'log' && (
        <div className="alert alert-info">
          SMS sending is not set up, so messages stay in this outbox and no customer receives them.
          {user?.role === 'admin' ? <> Add a Termii or Brevo account on <Link to="/settings">Settings</Link>.</> : ' An admin can set it up on the Settings page.'}
        </div>
      )}
      <div className="card">
        {loading && !data ? <SkeletonRows rows={6} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Order</th><th>To</th><th>Why</th><th>Message</th><th>Status</th></tr></thead>
              <tbody>
                {data?.messages.length === 0 && <tr><td colSpan={6} className="empty-row">No messages yet. They appear when drivers start trips to customers.</td></tr>}
                {data?.messages.map((m) => (
                  <tr key={m.id}>
                    <td className="text-sm text-muted">{fmtDateTime(m.created_at)}</td>
                    <td>{m.order_id ? <Link to={`/orders/${m.order_id}`}>#{m.order_id}</Link> : '–'}<span className="text-xs text-muted block">{m.customer_name}</span></td>
                    <td className="mono text-sm">{fmtPhone(m.to_phone)}</td>
                    <td className="text-sm">{REASON[m.reason]}{m.created_by && <span className="text-xs text-muted block">{m.created_by}</span>}</td>
                    <td className="text-sm sms-body">{m.body}</td>
                    <td><Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>{m.error && <span className="text-xs text-danger block">{m.error}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
