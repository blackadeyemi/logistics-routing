import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ErrorAlert, Modal } from '../components/ui';
import { ApiError, staffApi } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import type { ExtractedDraft, Order } from '../lib/types';
import { OrderForm } from './OrderForm';

const EXAMPLE = `Good afternoon, pls I need pickup from my shop at 23 Allen Avenue Ikeja, opposite Mr Biggs.
Deliver to Chinedu Okeke 0803 456 7890, 5 Admiralty way lekki phase 1, the white gate after GTB.
Na pay on delivery 15k. Abeg make una call am b4 reaching`;

/**
 * Paste a WhatsApp message, the AI reads it into a draft, the dispatcher
 * checks the draft in the normal order form and saves it. Nothing is saved
 * until they press Create order.
 */
export function OrderIntake({ onClose, onSaved }: { onClose: () => void; onSaved: (o: Order) => void }) {
  const { user } = useStaffAuth();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [draft, setDraft] = useState<ExtractedDraft | null>(null);

  const read = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotConfigured(false);
    try {
      setDraft(await staffApi<ExtractedDraft>('/ai/extract-order', { method: 'POST', body: { message } }));
    } catch (err) {
      const code = err instanceof ApiError ? (err.details as { code?: string } | undefined)?.code : undefined;
      if (code === 'not_configured') setNotConfigured(true);
      setError(err instanceof ApiError ? err.message : 'Could not read the message');
    } finally {
      setBusy(false);
    }
  };

  if (draft) {
    return <OrderForm draft={draft} onClose={onClose} onSaved={onSaved} onBack={() => setDraft(null)} />;
  }

  return (
    <Modal
      title="New order from WhatsApp"
      onClose={onClose}
      wide
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form="intake-form" className="btn btn-primary" disabled={busy || message.trim().length < 5}>
          <Icon name="sparkle" /> {busy ? 'Reading the message…' : 'Read message'}
        </button>
      </>}
    >
      <form id="intake-form" onSubmit={read}>
        <ErrorAlert error={error} />
        {notConfigured && (
          <p className="text-sm">
            {user?.role === 'admin'
              ? <>Add the key and model on <Link to="/settings">Settings</Link>.</>
              : 'Ask an admin to set it up. Meanwhile you can create the order by hand.'}
          </p>
        )}
        <p className="text-sm text-muted">Paste the customer's message as it is: Pidgin, abbreviations and forwarded text are fine. You check everything before the order is created.</p>
        <textarea
          className="form-control intake-text"
          rows={8}
          maxLength={4000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={EXAMPLE}
          autoFocus
          disabled={busy}
        />
        <div className="flex items-center gap-2 intake-foot">
          <span className="text-xs text-muted grow">{message.length} / 4000</span>
          {!message && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMessage(EXAMPLE)}>Try an example</button>}
        </div>
      </form>
    </Modal>
  );
}
