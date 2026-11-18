import { useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorAlert, Field, Modal, SkeletonRows } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import type { Vehicle, VehicleStatus, VehicleType } from '../lib/types';
import { useLoad } from '../lib/useLoad';

const TYPE_LABEL: Record<VehicleType, string> = { bike: 'Motorbike', keke: 'Keke', van: 'Van', truck: 'Truck' };
const STATUS_TONE: Record<VehicleStatus, string> = { active: 'brand', maintenance: 'warning', inactive: 'muted' };

export function Vehicles() {
  const { data, error, loading, reload } = useLoad(() => staffApi<Vehicle[]>('/vehicles'), []);
  const [editing, setEditing] = useState<Vehicle | 'new' | null>(null);
  const counts = data?.reduce<Record<string, number>>((m, v) => ({ ...m, [v.type]: (m[v.type] ?? 0) + 1 }), {});

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Vehicles</h1>
          <p>{counts ? Object.entries(counts).map(([t, n]) => `${n} ${TYPE_LABEL[t as VehicleType].toLowerCase()}${n > 1 ? 's' : ''}`).join(' · ') : 'Bikes, kekes, vans and trucks in your fleet.'}</p>
        </div>
        <div className="page-actions"><button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" /> Add vehicle</button></div>
      </div>
      <ErrorAlert error={error} />
      <div className="card">
        {loading && !data ? <SkeletonRows /> : data && data.length === 0 ? (
          <EmptyState title="No vehicles yet">Add the bikes and vans your drivers use.</EmptyState>
        ) : data && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Plate</th><th>Type</th><th className="num">Capacity</th><th>Status</th><th className="col-actions" /></tr></thead>
              <tbody>
                {data.map((v) => (
                  <tr key={v.id}>
                    <td className="mono fw-600">{v.plate_number}</td>
                    <td>{TYPE_LABEL[v.type]}</td>
                    <td className="num">{v.capacity_kg ? `${v.capacity_kg} kg` : <span className="text-muted">·</span>}</td>
                    <td><Badge tone={STATUS_TONE[v.status]}>{v.status}</Badge></td>
                    <td className="col-actions"><button className="btn btn-ghost btn-sm" onClick={() => setEditing(v)}><Icon name="edit" /> Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <VehicleForm vehicle={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
    </>
  );
}

function VehicleForm({ vehicle, onClose, onSaved }: { vehicle?: Vehicle; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    type: vehicle?.type ?? 'bike',
    plate_number: vehicle?.plate_number ?? '',
    capacity_kg: vehicle?.capacity_kg ? String(vehicle.capacity_kg) : '',
    status: vehicle?.status ?? 'active',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { type: f.type, plate_number: f.plate_number, capacity_kg: f.capacity_kg ? Number(f.capacity_kg) : null, status: f.status };
    try {
      if (vehicle) await staffApi(`/vehicles/${vehicle.id}`, { method: 'PATCH', body });
      else await staffApi('/vehicles', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? (err.status === 409 ? 'A vehicle with this plate number already exists' : err.message) : 'Could not save');
    }
  };

  return (
    <Modal title={vehicle ? `Edit ${vehicle.plate_number}` : 'Add vehicle'} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" form="vehicle-form" className="btn btn-primary">{vehicle ? 'Save changes' : 'Add vehicle'}</button>
    </>}>
      <form id="vehicle-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <div className="form-row">
          <Field label="Plate number" error={errors.plate_number}><input className="form-control mono" required value={f.plate_number} onChange={set('plate_number')} placeholder="LAG-123-AA" autoFocus /></Field>
          <Field label="Type">
            <select className="form-control" value={f.type} onChange={set('type')}>
              {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Capacity in kg (optional)" error={errors.capacity_kg} hint="Used by route optimization in Phase 3"><input className="form-control" type="number" min="0" step="any" value={f.capacity_kg} onChange={set('capacity_kg')} /></Field>
          <Field label="Status">
            <select className="form-control" value={f.status} onChange={set('status')}>
              <option value="active">Active</option>
              <option value="maintenance">In maintenance</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
        </div>
      </form>
    </Modal>
  );
}
