import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge, ErrorAlert, SkeletonRows } from '../components/ui';
import { ApiError, staffApi } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { fmtDateTime, fmtPhone } from '../lib/format';
import type { SmsMessage } from '../lib/types';
import { useLoad } from '../lib/useLoad';

const REASON: Record<SmsMessage['reason'], string> = { en_route: 'On the way', delivered: 'Delivered', manual: 'Sent by dispatch', test: 'Test from Settings' };
const STATUS: Record<SmsMessage['status'], { tone: string; label: string }> = {
  // The provider took it; delivery to the phone can still fail later.
  sent: { tone: 'info', label: 'Accepted by provider' },
  logged: { tone: 'muted', label: 'Outbox only' },
  failed: { tone: 'danger', label: 'Failed' },
};

// Brevo's result after accepting a text. Final ones are delivered,
// rejected, blocked, hard_bounce, skipped and unsubscribed.
export const DELIVERY: Record<string, { tone: string; label: string }> = {
  delivered: { tone: 'success', label: 'Delivered' },
  rejected: { tone: 'danger', label: 'Rejected by Brevo' },
  blocked: { tone: 'danger', label: 'Blocked' },
  hard_bounce: { tone: 'danger', label: 'Could not be delivered' },
  soft_bounce: { tone: 'warning', label: 'Delivery failed, may retry' },
  skipped: { tone: 'muted', label: 'Skipped' },
  unsubscribed: { tone: 'muted', label: 'Recipient opted out' },
  sent: { tone: 'info', label: 'Sent to the network' },
  accepted: { tone: 'info', label: 'Accepted' },
};

/** Every text customers were sent, or would be sent with SMS set up. */
export function Messages() {
  const { user } = useStaffAuth();
  const { data, error, loading, reload } = useLoad(() => staffApi<{ provider: string; messages: SmsMessage[] }>('/sms', { query: { limit: 100 } }), []);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    setCheckNote(null);
    try {
      const r = await staffApi<{ checked: number; updated: number }>('/sms/check-delivery', { method: 'POST' });
      setCheckNote(r.checked ? `Checked ${r.checked} text${r.checked === 1 ? '' : 's'} with Brevo: ${r.updated} updated.` : 'No texts waiting for a delivery result.');
      void reload();
    } catch (err) {
      setCheckNote(err instanceof ApiError ? err.message : 'Could not check');
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customer SMS</h1>
          <p>Texts with a tracking link, sent when the driver sets off to the customer and when the parcel is delivered, or by hand from an order.</p>
        </div>
        {data?.provider === 'brevo' && (
          <div className="page-actions">
            <button className="btn btn-ghost" onClick={check} disabled={checking}><Icon name="refresh" /> {checking ? 'Checking…' : 'Check delivery now'}</button>
          </div>
        )}
      </div>
      {checkNote && <div className="alert alert-info">{checkNote}</div>}
      {data?.provider === 'brevo' && <p className="text-xs text-muted">Delivery results are checked with Brevo every 2 minutes for 48 hours after sending.</p>}
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
              <thead><tr><th>When</th><th>Order</th><th>To</th><th>Why</th><th>Message</th><th>Status</th><th>Delivery</th></tr></thead>
              <tbody>
                {data?.messages.length === 0 && <tr><td colSpan={7} className="empty-row">No messages yet. They appear when drivers start trips to customers.</td></tr>}
                {data?.messages.map((m) => (
                  <tr key={m.id}>
                    <td className="text-sm text-muted">{fmtDateTime(m.created_at)}</td>
                    <td>{m.order_id ? <Link to={`/orders/${m.order_id}`}>#{m.order_id}</Link> : '–'}<span className="text-xs text-muted block">{m.customer_name}</span></td>
                    <td className="mono text-sm">{fmtPhone(m.to_phone)}</td>
                    <td className="text-sm">{REASON[m.reason]}{m.created_by && <span className="text-xs text-muted block">{m.created_by}</span>}</td>
                    <td className="text-sm sms-body">{m.body}</td>
                    <td><Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>{m.error && <span className="text-xs text-danger block">{m.error}</span>}</td>
                    <td>
                      {m.delivery_status
                        ? <><Badge tone={DELIVERY[m.delivery_status]?.tone ?? 'muted'}>{DELIVERY[m.delivery_status]?.label ?? m.delivery_status}</Badge>{m.delivery_at && <span className="text-xs text-muted block">{fmtDateTime(m.delivery_at)}</span>}</>
                        : m.status === 'sent' && m.provider === 'brevo' ? <span className="text-xs text-muted">Waiting for Brevo</span> : <span className="text-xs text-muted">–</span>}
                      {m.delivery_status === 'rejected' && <span className="text-xs text-muted block">Usually an unregistered sender ID or no SMS credits: see the reason in Brevo’s SMS logs.</span>}
                    </td>
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
