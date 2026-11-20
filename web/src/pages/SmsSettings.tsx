import { useState, type FormEvent } from 'react';
import { Badge, ErrorAlert, Field } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { AppSettings } from '../lib/types';

/**
 * Customer SMS: the public address used in tracking links, and Termii for
 * sending. Without Termii, texts stay in the dashboard's outbox.
 */
export function SmsSettings({ settings, onSaved }: { settings: AppSettings; onSaved: () => unknown }) {
  const s = settings.sms;
  const [f, setF] = useState({
    provider: s.provider, base_url: s.base_url, sender_id: s.sender_id, channel: s.channel,
    public_app_url: s.public_app_url, company_name: s.company_name, api_key: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    setSaved(false);
    try {
      const body: Record<string, string> = { provider: f.provider, base_url: f.base_url, sender_id: f.sender_id, channel: f.channel, public_app_url: f.public_app_url, company_name: f.company_name };
      if (f.api_key.trim()) body.api_key = f.api_key.trim();
      await staffApi('/settings', { method: 'PUT', body: { sms: body } });
      setF((x) => ({ ...x, api_key: '' }));
      setSaved(true);
      await onSaved();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k.replace(/^sms\./, ''), v])));
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTest(null);
    try {
      await staffApi('/settings/sms/test', { method: 'POST', body: { to: testTo } });
      setTest({ ok: true, text: 'Sent. Check the phone.' });
    } catch (err) {
      setTest({ ok: false, text: err instanceof ApiError ? err.message : 'Could not send' });
    }
  };

  const termii = f.provider === 'termii';
  return (
    <div className="settings-grid">
      <section className="card card-pad">
        <div className="flex items-center gap-2 settings-head">
          <h2 className="card-title grow">Customer SMS</h2>
          <Badge tone={s.provider === 'termii' ? 'success' : 'muted'}>{s.provider === 'termii' ? 'Termii' : 'Outbox only'}</Badge>
        </div>
        <p className="text-sm text-muted">Customers get a text with a tracking link when the driver sets off to them, and when the parcel is delivered.</p>
        <form onSubmit={save}>
          <ErrorAlert error={error} />
          {saved && <div className="alert alert-success">Saved.</div>}
          <div className="form-row">
            <Field label="Company name in texts" error={errors.company_name} hint="“Your … delivery is on the way”. Leave empty for “your delivery”.">
              <input className="form-control" maxLength={40} value={f.company_name} onChange={set('company_name')} placeholder="Swift Couriers" />
            </Field>
            <Field label="Tracking page address" error={errors.public_app_url} hint="Where customers open their link. Use your live address once deployed.">
              <input className="form-control mono" value={f.public_app_url} onChange={set('public_app_url')} />
            </Field>
          </div>
          <Field label="Sending">
            <select className="form-control" value={f.provider} onChange={set('provider')}>
              <option value="log">Do not send: keep texts in the dashboard outbox</option>
              <option value="termii">Send with Termii</option>
            </select>
          </Field>
          {termii && (
            <>
              <div className="form-row">
                <Field label="Termii base URL" error={errors.base_url} hint="Shown on your Termii dashboard, for example https://v3.api.termii.com">
                  <input className="form-control mono" value={f.base_url} onChange={set('base_url')} placeholder="https://…api.termii.com" />
                </Field>
                <Field label="Sender ID" error={errors.sender_id} hint="3 to 11 characters, approved by Termii">
                  <input className="form-control" maxLength={11} value={f.sender_id} onChange={set('sender_id')} />
                </Field>
              </div>
              <div className="form-row">
                <Field label="Termii API key" error={errors.api_key} hint={s.api_key_set ? `Saved: ${s.api_key_hint}. Leave empty to keep it.` : 'Stored encrypted. Never shown again.'}>
                  <input className="form-control mono" type="password" autoComplete="off" value={f.api_key} onChange={set('api_key')} disabled={!s.can_save_secrets} />
                </Field>
                <Field label="Route" hint="DND is Termii’s route for transactional messages: it reaches numbers on Do Not Disturb, and MTN’s 8pm to 8am limit does not apply. Termii must enable it on your account.">
                  <select className="form-control" value={f.channel} onChange={set('channel')}>
                    <option value="dnd">DND (transactional)</option>
                    <option value="generic">Generic</option>
                  </select>
                </Field>
              </div>
            </>
          )}
          <div className="flex gap-2 settings-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
          {s.updated_at && <p className="text-xs text-muted mb-0">Last changed {fmtDateTime(s.updated_at)}{s.updated_by && ` by ${s.updated_by}`}.</p>}
        </form>
      </section>

      <section className="card card-pad settings-help">
        <h2 className="card-title">Test a text</h2>
        <p className="text-sm text-muted">After saving Termii settings, send one message to your own phone.</p>
        <div className="flex gap-2">
          <input className="form-control mono grow" inputMode="tel" placeholder="0803 123 4567" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button type="button" className="btn btn-ghost" onClick={sendTest} disabled={s.provider !== 'termii' || !testTo.trim()}>Send test</button>
        </div>
        {test && <div className={`alert ${test.ok ? 'alert-success' : 'alert-error'} mt-2`}>{test.text}</div>}
        <p className="text-xs text-muted mb-0 mt-2">Each text is a few naira on Termii, billed to your Termii balance.</p>
      </section>
    </div>
  );
}
