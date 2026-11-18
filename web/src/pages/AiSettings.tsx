import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, ErrorAlert, Field, Modal } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { AiModel, AppSettings } from '../lib/types';

// What we know about the current models, to help an admin choose. Prices
// are USD per million tokens (input / output), Anthropic list prices as of
// November 2026. The live list from the key decides what is selectable.
const KNOWN: Record<string, { name: string; price: string; note: string; recommended?: boolean }> = {
  'claude-opus-5-5': { name: 'Claude Opus 5.5', price: '$4 / $20', note: 'Best balance of quality and cost. Handles messy messages and multi-step copilot tasks well.', recommended: true },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', price: '$2 / $10', note: 'Half the price of Opus and faster. A good fit for order intake if the evals hold up.' },
  'claude-haiku-5-5': { name: 'Claude Haiku 5.5', price: '$0.10 / $0.50', note: 'Cheapest and fastest. Worth trying for simple extraction; check the eval scores first.' },
  'claude-fable-5-2': { name: 'Claude Fable 5.2', price: '$8 / $40', note: 'Most capable, highest cost. Rarely needed for dispatch work.' },
};
const DEFAULT_MODEL = 'claude-opus-5-5';

type Check = { ok: true; models: AiModel[] } | { ok: false; message: string } | null;

export function AiSettings({ settings, onSaved }: { settings: AppSettings; onSaved: () => unknown }) {
  const ai = settings.ai;
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [model, setModel] = useState(ai.model || DEFAULT_MODEL);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Check>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => setModel(ai.model || DEFAULT_MODEL), [ai.model]);

  const status = ai.key_unreadable
    ? { tone: 'danger', text: 'Key unreadable' }
    : ai.key_source === 'settings' ? { tone: 'success', text: 'Key saved' }
      : ai.key_source === 'env' ? { tone: 'info', text: 'Using the .env key' }
        : { tone: 'muted', text: 'Not set up' };

  // Known models first (in our order), then anything else the key can use.
  const options = useMemo(() => {
    const live = check?.ok ? check.models : null;
    const ids = live ? live.map((m) => m.id) : Object.keys(KNOWN);
    const known = Object.keys(KNOWN).filter((id) => ids.includes(id));
    const other = live ? live.filter((m) => !KNOWN[m.id]) : [];
    return { known, other, live };
  }, [check]);
  const modelMissing = !!options.live && !options.live.some((m) => m.id === model);

  const runCheck = async () => {
    setChecking(true);
    setCheck(null);
    try {
      const body = key.trim() ? { api_key: key.trim() } : {};
      const res = await staffApi<{ ok: true; models: AiModel[] }>('/settings/ai/check', { method: 'POST', body });
      setCheck({ ok: true, models: res.models });
    } catch (err) {
      setCheck({ ok: false, message: err instanceof ApiError ? (fieldErrors(err).api_key ?? err.message) : 'Could not check the key' });
    } finally {
      setChecking(false);
    }
  };

  const save = async (body: { api_key?: string; model?: string }, message: string) => {
    setBusy(true);
    setError(null);
    setErrors({});
    setSaved(null);
    try {
      await staffApi<AppSettings>('/settings', { method: 'PUT', body: { ai: body } });
      setKey('');
      setSaved(message);
      await onSaved();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors({ api_key: fe['ai.api_key'] ?? '', model: fe['ai.model'] ?? '' });
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: { api_key?: string; model?: string } = { model };
    if (key.trim()) body.api_key = key.trim();
    void save(body, key.trim() ? 'Key and model saved.' : 'Model saved.');
  };

  const dirty = !!key.trim() || model !== (ai.model || '');

  return (
    <div className="settings-grid">
    <section className="card card-pad">
      <div className="flex items-center gap-2 settings-head">
        <h2 className="card-title grow">AI assistant (Claude)</h2>
        <Badge tone={status.tone}>{status.text}</Badge>
      </div>
      <p className="text-sm text-muted">Turns pasted WhatsApp messages into orders and powers the dispatch copilot. Calls go from the server to Anthropic and are billed to this key.</p>

      <form onSubmit={submit}>
        <ErrorAlert error={error} />
        {saved && <div className="alert alert-success">{saved}</div>}
        {!ai.can_save_secrets && (
          <div className="alert alert-warning">The server has no <code>SETTINGS_ENCRYPTION_KEY</code>, so it cannot store an API key yet. Add one to <code>.env</code> (<code>openssl rand -base64 32</code>) and restart api-node.</div>
        )}
        {ai.key_unreadable && (
          <div className="alert alert-error">A key is saved but the server cannot decrypt it, usually because <code>SETTINGS_ENCRYPTION_KEY</code> changed. Enter the key again.</div>
        )}

        <Field
          label="Anthropic API key"
          error={errors.api_key || undefined}
          hint={ai.api_key_set
            ? `Current key: ${ai.api_key_hint}${ai.key_source === 'env' ? ' (from .env)' : ''}. Leave empty to keep it. The full key is never shown again.`
            : 'From the Claude Console, API keys. Starts with sk-ant-. Stored encrypted on the server.'}
        >
          <div className="flex gap-2">
            <input
              className="form-control mono grow"
              type={show ? 'text' : 'password'}
              value={key}
              onChange={(e) => { setKey(e.target.value); setCheck(null); }}
              placeholder={ai.api_key_set ? `${ai.api_key_hint} (saved)` : 'sk-ant-…'}
              autoComplete="off"
              spellCheck={false}
              disabled={!ai.can_save_secrets}
            />
            <button type="button" className="btn btn-ghost" onClick={() => setShow((s) => !s)} aria-pressed={show} disabled={!key}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </Field>

        <div className="flex gap-2 settings-actions">
          <button type="button" className="btn btn-ghost" onClick={runCheck} disabled={checking || (!key.trim() && !ai.api_key_set)}>
            <Icon name="refresh" /> {checking ? 'Checking…' : key.trim() ? 'Check this key' : 'Check saved key'}
          </button>
          <span className="text-xs text-muted">Confirms the key works and loads the models it can use. Free, no tokens used.</span>
        </div>
        {check && !check.ok && <div className="alert alert-error">{check.message}</div>}
        {check?.ok && <div className="alert alert-success">The key works. {check.models.length} models available.</div>}

        <div className="form-group">
          <label className="form-label">Model</label>
          <div className="model-list" role="radiogroup" aria-label="Model">
            {options.known.map((id) => {
              const k = KNOWN[id]!;
              const live = options.live?.find((m) => m.id === id);
              return (
                <label key={id} className={`model-opt${model === id ? ' selected' : ''}`}>
                  <input type="radio" name="model" value={id} checked={model === id} onChange={() => setModel(id)} />
                  <span className="grow">
                    <span className="model-name">{live?.display_name ?? k.name} {k.recommended && <Badge tone="brand">Recommended</Badge>}</span>
                    <span className="text-xs text-muted">{k.note}</span>
                  </span>
                  <span className="model-price text-xs"><strong>{k.price}</strong><span className="text-muted">per 1M tokens in / out</span></span>
                </label>
              );
            })}
          </div>
          {options.other.length > 0 && (
            <details className="model-more">
              <summary className="text-sm">Other models this key can use ({options.other.length})</summary>
              <div className="model-list">
                {options.other.map((m) => (
                  <label key={m.id} className={`model-opt${model === m.id ? ' selected' : ''}`}>
                    <input type="radio" name="model" value={m.id} checked={model === m.id} onChange={() => setModel(m.id)} />
                    <span className="grow">
                      <span className="model-name">{m.display_name}</span>
                      <span className="text-xs text-muted mono">{m.id}</span>
                    </span>
                  </label>
                ))}
              </div>
            </details>
          )}
          {errors.model ? <div className="form-error">{errors.model}</div>
            : modelMissing ? <div className="form-error">This key cannot use {model}. Pick another model.</div>
              : <div className="form-hint">{options.live ? 'Showing the models this key can use.' : 'Check the key to see every model it can use.'} {ai.model_source === 'env' && `Currently ${ai.model} from LLM_MODEL in .env.`}</div>}
        </div>

        <div className="flex gap-2 settings-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty || modelMissing}>{busy ? 'Saving…' : 'Save'}</button>
          <span className="grow" />
          {ai.key_source === 'settings' && <button type="button" className="btn btn-ghost text-danger" onClick={() => setConfirmRemove(true)}>Remove key</button>}
        </div>
        {ai.updated_at && <p className="text-xs text-muted mb-0">Last changed {fmtDateTime(ai.updated_at)}{ai.updated_by && ` by ${ai.updated_by}`}.</p>}
      </form>

      {confirmRemove && (
        <Modal title="Remove the Anthropic API key?" onClose={() => setConfirmRemove(false)} footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirmRemove(false)}>Keep it</button>
          <button className="btn btn-danger" onClick={() => { setConfirmRemove(false); void save({ api_key: '' }, 'Key removed. AI features are off unless .env has a key.'); }}>Remove key</button>
        </>}>
          <p className="mb-0">Order intake and the copilot stop working until a key is added again{ai.key_source === 'settings' ? ', unless ANTHROPIC_API_KEY is set in .env' : ''}.</p>
        </Modal>
      )}
    </section>

    <section className="card card-pad settings-help">
      <h2 className="card-title">Getting a key</h2>
      <ol>
        <li>Sign in to the <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">Claude Console, API keys <Icon name="external" size={13} /></a> and add credit or a payment method under Billing.</li>
        <li>Create a key for this app, ideally in its own workspace so you can set a monthly spend limit.</li>
        <li>Paste it here, press <strong>Check this key</strong>, pick a model and <strong>Save</strong>.</li>
      </ol>
      <p className="text-xs text-muted mb-0">The key stays on the server, encrypted. Browsers, including this one, only ever see the masked hint. Anyone with access to the server's <code>.env</code> and database could still recover it, so treat both as secret.</p>
    </section>
    </div>
  );
}
