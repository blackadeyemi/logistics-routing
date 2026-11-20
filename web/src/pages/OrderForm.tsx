import { useState, type FormEvent } from 'react';
import { AddressInput, StopsMap, useMapsEnabled, type MapPoint } from '../components/maps';
import { Icon } from '../components/Icon';
import { ErrorAlert, Field, Modal } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import { fmtPhone } from '../lib/format';
import type { ExtractedDraft, LatLng, Order } from '../lib/types';

// Dispatchers paste coordinates straight from Google Maps: "6.6142, 3.3581".
function parseLatLng(text: string): LatLng | null | 'invalid' {
  const t = text.trim();
  if (!t) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return 'invalid';
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return 'invalid';
  return { lat, lng };
}
const showLatLng = (l: LatLng | null) => (l ? `${l.lat}, ${l.lng}` : '');

const FIELD_LABEL: Record<string, string> = {
  customer_name: 'customer name', customer_phone: 'phone number', pickup_address: 'pickup address', dropoff_address: 'dropoff address',
};

/**
 * Create or edit an order. With `draft` it opens prefilled from a WhatsApp
 * message read by the AI, for the dispatcher to check and complete.
 */
export function OrderForm({ order, draft, onClose, onSaved, onBack }: {
  order?: Order;
  draft?: ExtractedDraft;
  onClose: () => void;
  onSaved: (o: Order) => void;
  onBack?: () => void;
}) {
  const d = draft?.draft;
  const [f, setF] = useState({
    customer_name: order?.customer_name ?? d?.customer_name ?? '',
    customer_phone: order ? fmtPhone(order.customer_phone) : d?.customer_phone ? (draft?.phone_valid ? fmtPhone(d.customer_phone) : d.customer_phone) : '',
    pickup_address: order?.pickup_address ?? d?.pickup_address ?? '',
    pickup_location: showLatLng(order?.pickup_location ?? null),
    pickup_notes: order?.pickup_notes ?? d?.pickup_notes ?? '',
    dropoff_address: order?.dropoff_address ?? d?.dropoff_address ?? '',
    dropoff_location: showLatLng(order?.dropoff_location ?? null),
    dropoff_notes: order?.dropoff_notes ?? d?.dropoff_notes ?? '',
    weight_kg: String(order?.weight_kg ?? 1),
    dropoff_after: order?.dropoff_after ?? '',
    dropoff_before: order?.dropoff_before ?? '',
  });
  const missing = new Set(draft?.missing ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const pickupLocked = !!order && !['pending', 'assigned'].includes(order.status);
  const maps = useMapsEnabled();
  const setText = (k: 'pickup_address' | 'dropoff_address') => (text: string) => setF((s) => ({ ...s, [k]: text }));
  const setPlace = (kind: 'pickup' | 'dropoff') => (p: { address: string; location: LatLng }) =>
    setF((s) => ({ ...s, [`${kind}_address`]: p.address, [`${kind}_location`]: showLatLng(p.location) }));

  // Preview whatever coordinates are filled in, so a wrong suggestion
  // (the Allen Avenue in Ikeja, not the one in Ibadan) is easy to spot.
  const preview: MapPoint[] = (['pickup', 'dropoff'] as const).flatMap((kind) => {
    const loc = parseLatLng(f[`${kind}_location`]);
    return loc && loc !== 'invalid'
      ? [{ id: kind, kind, location: loc, label: kind === 'pickup' ? 'P' : 'D', title: f[`${kind}_address`] || kind }]
      : [];
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pickup = parseLatLng(f.pickup_location);
    const dropoff = parseLatLng(f.dropoff_location);
    const local: Record<string, string> = {};
    if (pickup === 'invalid') local.pickup_location = 'Use "latitude, longitude", for example 6.6142, 3.3581';
    if (dropoff === 'invalid') local.dropoff_location = 'Use "latitude, longitude", for example 6.4474, 3.4723';
    if (Object.keys(local).length) { setErrors(local); return; }

    const body: Record<string, unknown> = {
      customer_name: f.customer_name,
      customer_phone: f.customer_phone,
      pickup_notes: f.pickup_notes,
      dropoff_notes: f.dropoff_notes,
      weight_kg: Number(f.weight_kg),
      dropoff_after: f.dropoff_after,
      dropoff_before: f.dropoff_before,
    };
    if (!pickupLocked) {
      Object.assign(body, {
        pickup_address: f.pickup_address, pickup_location: pickup,
        dropoff_address: f.dropoff_address, dropoff_location: dropoff,
      });
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const saved = order
        ? await staffApi<Order>(`/orders/${order.id}`, { method: 'PATCH', body })
        : await staffApi<Order>('/orders', { method: 'POST', body });
      onSaved(saved);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : 'Could not save the order');
    } finally {
      setBusy(false);
    }
  };

  const gap = (k: string, normal?: string) => (missing.has(k) ? 'Not in the message. Ask the customer.' : normal);
  const gapClass = (k: string) => (missing.has(k) && !f[k as keyof typeof f] ? ' is-missing' : '');

  return (
    <Modal
      title={order ? `Edit order #${order.id}` : draft ? 'Check the order from WhatsApp' : 'New order'}
      onClose={onClose}
      wide
      footer={<>
        {onBack && <button type="button" className="btn btn-ghost" onClick={onBack}><Icon name="left" /> Back to message</button>}
        <span className="grow" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form="order-form" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : order ? 'Save changes' : 'Create order'}</button>
      </>}
    >
      <form id="order-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        {draft && (
          <div className="alert alert-info draft-banner">
            <Icon name="sparkle" />
            <div>
              <strong>Filled in by AI from the message.</strong> Check every field before you create the order.
              {draft.missing.length > 0 && <div>Missing: {draft.missing.map((k) => FIELD_LABEL[k] ?? k).join(', ')}.</div>}
              {draft.warnings.map((w) => <div key={w} className="text-warning">{w}</div>)}
            </div>
          </div>
        )}
        <div className="form-section">Customer</div>
        <div className="form-row">
          <Field label="Name" error={errors.customer_name} hint={gap('customer_name')}>
            <input className={`form-control${gapClass('customer_name')}`} required value={f.customer_name} onChange={set('customer_name')} autoFocus />
          </Field>
          <Field label="Phone" error={errors.customer_phone} hint={gap('customer_phone', 'Any Nigerian format, 0803 123 4567 or +234…')}>
            <input className={`form-control mono${gapClass('customer_phone')}`} required inputMode="tel" value={f.customer_phone} onChange={set('customer_phone')} />
          </Field>
        </div>

        {pickupLocked && <div className="alert alert-warning">The driver has already collected this order, so the addresses are locked.</div>}

        <div className="form-section">Pickup</div>
        <Field label="Address" error={errors.pickup_address} hint={gap('pickup_address', maps && !pickupLocked ? 'Start typing and pick a suggestion to fill the coordinates.' : undefined)}>
          <div className={gapClass('pickup_address')}>
            <AddressInput required disabled={pickupLocked} value={f.pickup_address} onChange={setText('pickup_address')} onPick={setPlace('pickup')} placeholder="Ikeja City Mall, Obafemi Awolowo Way" />
          </div>
        </Field>
        <Field label="Coordinates (optional)" error={errors.pickup_location} hint={maps ? 'Filled from the address. You can also paste from Google Maps.' : 'Paste from Google Maps. Used for distance estimates now and optimization later.'}>
          <input className="form-control mono" disabled={pickupLocked} value={f.pickup_location} onChange={set('pickup_location')} placeholder="e.g. 6.6142, 3.3581" />
        </Field>
        <Field label="Notes for the driver (optional)" error={errors.pickup_notes} hint="Who to ask for, what to collect. The driver sees this at the pickup.">
          <textarea className="form-control" rows={2} maxLength={1000} value={f.pickup_notes} onChange={set('pickup_notes')} placeholder="Ask for Mama Ngozi at the counter" />
        </Field>

        <div className="form-section">Dropoff</div>
        <Field label="Address" error={errors.dropoff_address} hint={gap('dropoff_address')}>
          <div className={gapClass('dropoff_address')}>
            <AddressInput required disabled={pickupLocked} value={f.dropoff_address} onChange={setText('dropoff_address')} onPick={setPlace('dropoff')} placeholder="12 Admiralty Way, Lekki Phase 1" />
          </div>
        </Field>
        <Field label="Coordinates (optional)" error={errors.dropoff_location}>
          <input className="form-control mono" disabled={pickupLocked} value={f.dropoff_location} onChange={set('dropoff_location')} placeholder="e.g. 6.4474, 3.4723" />
        </Field>
        <Field label="Notes for the driver (optional)" error={errors.dropoff_notes} hint="Landmarks, gate, money to collect, call on arrival. The driver sees this at the dropoff.">
          <textarea className="form-control" rows={2} maxLength={1000} value={f.dropoff_notes} onChange={set('dropoff_notes')} placeholder="White gate after GTB. Call on arrival. Collect ₦15,000." />
        </Field>

        <div className="form-section">For route planning</div>
        <div className="form-row form-row-3">
          <Field label="Parcel weight (kg)" error={errors.weight_kg} hint="Checked against vehicle capacity.">
            <input className="form-control" type="number" min="0.1" step="0.1" max="5000" required value={f.weight_kg} onChange={set('weight_kg')} />
          </Field>
          <Field label="Deliver after (optional)" error={errors.dropoff_after} hint="Lagos time">
            <input className="form-control" type="time" value={f.dropoff_after} onChange={set('dropoff_after')} />
          </Field>
          <Field label="Deliver before (optional)" error={errors.dropoff_before}>
            <input className="form-control" type="time" value={f.dropoff_before} onChange={set('dropoff_before')} />
          </Field>
        </div>

        {maps && preview.length > 0 && <StopsMap points={preview} height={220} className="form-map" />}
      </form>
    </Modal>
  );
}
