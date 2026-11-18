import { useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorAlert, Field, Modal, SkeletonRows } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import { fmtPhone, initials } from '../lib/format';
import type { Driver, Vehicle } from '../lib/types';
import { useLoad } from '../lib/useLoad';

export function Drivers() {
  const { data, error, loading, reload } = useLoad(async () => {
    const [drivers, vehicles] = await Promise.all([staffApi<Driver[]>('/drivers'), staffApi<Vehicle[]>('/vehicles')]);
    return { drivers, vehicles };
  }, []);
  const [editing, setEditing] = useState<Driver | 'new' | null>(null);
  const [pinFor, setPinFor] = useState<Driver | null>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Drivers</h1>
          <p>Drivers log in to the driver app with their phone number and a PIN you set here.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" /> Add driver</button>
        </div>
      </div>
      <ErrorAlert error={error} />
      <div className="card">
        {loading && !data ? <SkeletonRows /> : data && data.drivers.length === 0 ? (
          <EmptyState title="No drivers yet">Add your first rider or driver to start assigning routes.</EmptyState>
        ) : data && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Driver</th><th>Phone</th><th>Vehicle</th><th>App login</th><th>Status</th><th className="col-actions" /></tr></thead>
              <tbody>
                {data.drivers.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="avatar">{initials(d.name)}</span>
                        <div><div className="fw-600">{d.name}</div>{d.email && <div className="text-xs text-muted">{d.email}</div>}</div>
                      </div>
                    </td>
                    <td className="mono">{fmtPhone(d.phone)}</td>
                    <td>{d.vehicle ? <>{d.vehicle.plate_number} <span className="text-muted text-sm">· {d.vehicle.type}</span></> : <span className="text-muted">None</span>}</td>
                    <td>{d.has_pin ? <Badge tone="success">PIN set</Badge> : <Badge tone="warning">No PIN</Badge>}</td>
                    <td>{d.status === 'active' ? <Badge tone="brand">Active</Badge> : <Badge tone="muted">Inactive</Badge>}</td>
                    <td className="col-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setPinFor(d)}><Icon name="key" /> {d.has_pin ? 'Reset PIN' : 'Set PIN'}</button>{' '}
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(d)}><Icon name="edit" /> Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && data && (
        <DriverForm driver={editing === 'new' ? undefined : editing} vehicles={data.vehicles} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />
      )}
      {pinFor && <PinForm driver={pinFor} onClose={() => setPinFor(null)} onSaved={() => { setPinFor(null); void reload(); }} />}
    </>
  );
}

function DriverForm({ driver, vehicles, onClose, onSaved }: { driver?: Driver; vehicles: Vehicle[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: driver?.name ?? '',
    phone: driver ? fmtPhone(driver.phone) : '',
    email: driver?.email ?? '',
    vehicle_id: driver?.vehicle_id ? String(driver.vehicle_id) : '',
    status: driver?.status ?? 'active',
    pin: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      name: f.name, phone: f.phone, email: f.email.trim() || null,
      vehicle_id: f.vehicle_id ? Number(f.vehicle_id) : null, status: f.status,
    };
    if (!driver && f.pin) body.pin = f.pin;
    try {
      if (driver) await staffApi(`/drivers/${driver.id}`, { method: 'PATCH', body });
      else await staffApi('/drivers', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : 'Could not save');
      setBusy(false);
    }
  };

  return (
    <Modal title={driver ? `Edit ${driver.name}` : 'Add driver'} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" form="driver-form" className="btn btn-primary" disabled={busy}>{driver ? 'Save changes' : 'Add driver'}</button>
    </>}>
      <form id="driver-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Full name" error={errors.name}><input className="form-control" required value={f.name} onChange={set('name')} autoFocus /></Field>
        <div className="form-row">
          <Field label="Phone" error={errors.phone} hint="Used to log in to the driver app"><input className="form-control mono" required inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="0803 123 4567" /></Field>
          <Field label="Email (optional)" error={errors.email}><input className="form-control" type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
        <div className="form-row">
          <Field label="Vehicle" error={errors.vehicle_id}>
            <select className="form-control" value={f.vehicle_id} onChange={set('vehicle_id')}>
              <option value="">No vehicle</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate_number} · {v.type}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select className="form-control" value={f.status} onChange={set('status')}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
        </div>
        {!driver && (
          <Field label="App PIN (optional)" error={errors.pin} hint="4 to 6 digits. You can set it later.">
            <input className="form-control mono" inputMode="numeric" pattern="\d{4,6}" maxLength={6} value={f.pin} onChange={set('pin')} />
          </Field>
        )}
      </form>
    </Modal>
  );
}

function PinForm({ driver, onClose, onSaved }: { driver: Driver; onClose: () => void; onSaved: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await staffApi(`/drivers/${driver.id}/pin`, { method: 'PUT', body: { pin } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? (fieldErrors(err).pin ?? err.message) : 'Could not set the PIN');
    }
  };
  return (
    <Modal title={`${driver.has_pin ? 'Reset' : 'Set'} PIN for ${driver.name}`} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" form="pin-form" className="btn btn-primary" disabled={!/^\d{4,6}$/.test(pin)}>Save PIN</button>
    </>}>
      <form id="pin-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="New PIN" hint={`Tell ${driver.name.split(' ')[0]} by phone. They log in with ${fmtPhone(driver.phone)} and this PIN.`}>
          <input className="form-control mono pin-input" inputMode="numeric" autoFocus maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </form>
    </Modal>
  );
}
