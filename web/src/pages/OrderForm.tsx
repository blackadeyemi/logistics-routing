import { useState, type FormEvent } from 'react';
import { AddressInput, StopsMap, useMapsEnabled, type MapPoint } from '../components/maps';
import { ErrorAlert, Field, Modal } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import { fmtPhone } from '../lib/format';
import type { LatLng, Order } from '../lib/types';

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

export function OrderForm({ order, onClose, onSaved }: { order?: Order; onClose: () => void; onSaved: (o: Order) => void }) {
  const [f, setF] = useState({
    customer_name: order?.customer_name ?? '',
    customer_phone: order ? fmtPhone(order.customer_phone) : '',
    pickup_address: order?.pickup_address ?? '',
    pickup_location: showLatLng(order?.pickup_location ?? null),
    dropoff_address: order?.dropoff_address ?? '',
    dropoff_location: showLatLng(order?.dropoff_location ?? null),
  });
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

  return (
    <Modal
      title={order ? `Edit order #${order.id}` : 'New order'}
      onClose={onClose}
      wide
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form="order-form" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : order ? 'Save changes' : 'Create order'}</button>
      </>}
    >
      <form id="order-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <div className="form-section">Customer</div>
        <div className="form-row">
          <Field label="Name" error={errors.customer_name}>
            <input className="form-control" required value={f.customer_name} onChange={set('customer_name')} autoFocus />
          </Field>
          <Field label="Phone" error={errors.customer_phone} hint="Any Nigerian format, 0803 123 4567 or +234…">
            <input className="form-control mono" required inputMode="tel" value={f.customer_phone} onChange={set('customer_phone')} />
          </Field>
        </div>

        {pickupLocked && <div className="alert alert-warning">The driver has already collected this order, so the addresses are locked.</div>}

        <div className="form-section">Pickup</div>
        <Field label="Address" error={errors.pickup_address} hint={maps && !pickupLocked ? 'Start typing and pick a suggestion to fill the coordinates.' : undefined}>
          <AddressInput required disabled={pickupLocked} value={f.pickup_address} onChange={setText('pickup_address')} onPick={setPlace('pickup')} placeholder="Ikeja City Mall, Obafemi Awolowo Way" />
        </Field>
        <Field label="Coordinates (optional)" error={errors.pickup_location} hint={maps ? 'Filled from the address. You can also paste from Google Maps.' : 'Paste from Google Maps. Used for distance estimates now and optimization later.'}>
          <input className="form-control mono" disabled={pickupLocked} value={f.pickup_location} onChange={set('pickup_location')} placeholder="6.6142, 3.3581" />
        </Field>

        <div className="form-section">Dropoff</div>
        <Field label="Address" error={errors.dropoff_address}>
          <AddressInput required disabled={pickupLocked} value={f.dropoff_address} onChange={setText('dropoff_address')} onPick={setPlace('dropoff')} placeholder="12 Admiralty Way, Lekki Phase 1" />
        </Field>
        <Field label="Coordinates (optional)" error={errors.dropoff_location}>
          <input className="form-control mono" disabled={pickupLocked} value={f.dropoff_location} onChange={set('dropoff_location')} placeholder="6.4474, 3.4723" />
        </Field>

        {maps && preview.length > 0 && <StopsMap points={preview} height={220} className="form-map" />}
      </form>
    </Modal>
  );
}
