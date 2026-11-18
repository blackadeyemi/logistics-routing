import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge, ErrorAlert, Field, Modal, SkeletonRows } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { configureMaps, loadedMapsKey } from '../lib/maps';
import type { AppSettings } from '../lib/types';
import { useLoad } from '../lib/useLoad';
import { AiSettings } from './AiSettings';

const ENV_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() ?? '';

type TestResult = { ok: boolean; message: string } | null;

// Calls Places API (New) straight from this browser, so the result reflects
// this key's API and referrer restrictions exactly as the app will hit them.
async function testKey(key: string): Promise<TestResult> {
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({ input: 'Ikeja City Mall', includedRegionCodes: ['ng'] }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const first = body.suggestions?.[0]?.placePrediction?.text?.text;
      return { ok: true, message: first ? `Address search works. First result for "Ikeja City Mall": ${first}.` : 'Address search works.' };
    }
    const msg: string = body.error?.message ?? `Google answered ${res.status}`;
    if (/referer|referrer/i.test(msg)) return { ok: false, message: `This address is not in the key's allowed websites. Add ${window.location.origin}/* under Website restrictions. (${msg})` };
    if (/not been used|disabled|SERVICE_DISABLED/i.test(msg + JSON.stringify(body.error?.details ?? ''))) return { ok: false, message: `Places API (New) is not enabled for this key's project. Enable it in Google Cloud, then wait a few minutes. (${msg})` };
    if (/billing/i.test(msg)) return { ok: false, message: `The Google Cloud project has no billing account. (${msg})` };
    if (/API key not valid|API_KEY_INVALID/i.test(msg + JSON.stringify(body.error?.details ?? ''))) return { ok: false, message: 'Google does not recognise this key. Check it was copied in full.' };
    return { ok: false, message: msg };
  } catch {
    return { ok: false, message: 'Could not reach Google. Check the internet connection.' };
  }
}

export function Settings() {
  const { user } = useStaffAuth();
  const { data, error, loading, reload } = useLoad(() => staffApi<AppSettings>('/settings'), []);
  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <>
      <div className="page-head">
        <div><h1>Settings</h1><p>Connections and options for the whole company.</p></div>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <div className="card"><SkeletonRows rows={4} /></div> : data && (
        <div className="settings-stack">
          <AiSettings settings={data} onSaved={reload} />
          <MapsSettings settings={data} onSaved={reload} />
        </div>
      )}
    </>
  );
}

function MapsSettings({ settings, onSaved }: { settings: AppSettings; onSaved: () => unknown }) {
  const gm = settings.google_maps;
  const [key, setKey] = useState(gm.api_key);
  const [mapIdText, setMapIdText] = useState(gm.map_id);
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => { setKey(gm.api_key); setMapIdText(gm.map_id); }, [gm.api_key, gm.map_id]);

  const dirty = key.trim() !== gm.api_key || mapIdText.trim() !== gm.map_id;
  const status = gm.api_key
    ? { tone: 'success' as const, text: 'Key saved' }
    : ENV_KEY ? { tone: 'info' as const, text: 'Using the .env key' } : { tone: 'muted' as const, text: 'Not set up' };

  const save = async (body: { api_key: string; map_id: string }) => {
    setBusy(true);
    setError(null);
    setErrors({});
    setSaved(null);
    try {
      const res = await staffApi<AppSettings>('/settings', { method: 'PUT', body: { google_maps: body } });
      const next = res.google_maps;
      const effective = next.api_key || ENV_KEY;
      // Google's script stays loaded with the old key until the page reloads.
      const loaded = loadedMapsKey();
      if (loaded !== null && loaded !== effective) setNeedsReload(true);
      else configureMaps({ key: next.api_key, mapId: next.map_id });
      setSaved(next.api_key ? 'Saved. Maps and address search are on for everyone on their next page load.' : 'Key removed. Maps are off and the app uses typed coordinates.');
      await onSaved();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors({ api_key: fe['google_maps.api_key'] ?? fe.api_key ?? '', map_id: fe['google_maps.map_id'] ?? fe.map_id ?? '' });
      setError(err instanceof ApiError ? err.message : 'Could not save the settings');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({ api_key: key.trim(), map_id: mapIdText.trim() });
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setTest(await testKey(key.trim()));
    setTesting(false);
  };

  return (
    <div className="settings-grid">
      <section className="card card-pad">
        <div className="flex items-center gap-2 settings-head">
          <h2 className="card-title grow">Google Maps</h2>
          <Badge tone={status.tone}>{status.text}</Badge>
        </div>
        <p className="text-sm text-muted">Address search on orders and the maps on order and route pages. Drivers are not affected: their Navigate button always opens the Google Maps app.</p>

        <form onSubmit={submit}>
          <ErrorAlert error={error} />
          {saved && <div className="alert alert-success">{saved}</div>}
          {needsReload && (
            <div className="alert alert-warning flex items-center gap-2">
              <span className="grow">This page still uses the previous key. Reload to switch.</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}><Icon name="refresh" /> Reload</button>
            </div>
          )}

          <Field label="API key" error={errors.api_key || undefined} hint="Starts with AIza. Stored on the server and sent to staff browsers to draw maps.">
            <div className="flex gap-2">
              <input
                className="form-control mono grow"
                type={show ? 'text' : 'password'}
                value={key}
                onChange={(e) => { setKey(e.target.value); setTest(null); }}
                placeholder="AIzaSy…"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="btn btn-ghost" onClick={() => setShow((s) => !s)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
            </div>
          </Field>

          <Field label="Map ID (optional)" error={errors.map_id || undefined} hint="From Google Cloud, Map management. Leave empty to use Google's demo map ID, fine for testing.">
            <input className="form-control mono" value={mapIdText} onChange={(e) => setMapIdText(e.target.value)} placeholder="DEMO_MAP_ID" autoComplete="off" spellCheck={false} />
          </Field>

          {test && <div className={`alert ${test.ok ? 'alert-success' : 'alert-error'}`}>{test.message}</div>}

          <div className="flex gap-2 settings-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-ghost" disabled={!key.trim() || testing} onClick={runTest}>{testing ? 'Testing…' : 'Test key'}</button>
            <span className="grow" />
            {gm.api_key && <button type="button" className="btn btn-ghost text-danger" onClick={() => setConfirmRemove(true)}>Remove key</button>}
          </div>
          {gm.updated_at && <p className="text-xs text-muted mb-0">Last changed {fmtDateTime(gm.updated_at)}{gm.updated_by && ` by ${gm.updated_by}`}.</p>}
        </form>
      </section>

      <section className="card card-pad settings-help">
        <h2 className="card-title">Getting a key</h2>
        <ol>
          <li>Open <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noreferrer">Google Cloud, Keys and credentials <Icon name="external" size={13} /></a>. The project needs a billing account.</li>
          <li>Enable <strong>Maps JavaScript API</strong> and <strong>Places API (New)</strong>.</li>
          <li>Create an API key. Under <strong>Website restrictions</strong>, add:
            <ul>
              <li><code>{window.location.origin}/*</code></li>
              <li>your live domain once the app is deployed</li>
            </ul>
          </li>
          <li>Under <strong>API restrictions</strong>, allow only those two APIs.</li>
          <li>Paste the key here, press <strong>Test key</strong>, then <strong>Save</strong>.</li>
        </ol>
        <p className="text-xs text-muted mb-0">The key is visible to anyone who opens the app, as with every website that shows Google Maps. The website and API restrictions are what stop others using it.</p>
      </section>

      {confirmRemove && (
        <Modal title="Remove the Google Maps key?" onClose={() => setConfirmRemove(false)} footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirmRemove(false)}>Keep it</button>
          <button className="btn btn-danger" onClick={() => { setConfirmRemove(false); setKey(''); void save({ api_key: '', map_id: '' }); }}>Remove key</button>
        </>}>
          <p className="mb-0">Maps and address search turn off for everyone. Orders keep their saved coordinates.</p>
        </Modal>
      )}
    </div>
  );
}
