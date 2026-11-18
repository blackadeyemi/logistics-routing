import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge, ErrorAlert, Field, Modal, SkeletonRows } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { fmtDateTime, initials } from '../lib/format';
import type { Role, User } from '../lib/types';
import { useLoad } from '../lib/useLoad';

export function Users() {
  const { user: me } = useStaffAuth();
  const { data, error, loading, reload } = useLoad(() => staffApi<User[]>('/users'), []);
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  if (me?.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <>
      <div className="page-head">
        <div><h1>Staff users</h1><p>Dispatchers run the day. Admins also manage staff accounts.</p></div>
        <div className="page-actions"><button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" /> Add user</button></div>
      </div>
      <ErrorAlert error={error} />
      <div className="card">
        {loading && !data ? <SkeletonRows /> : data && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Added</th><th className="col-actions" /></tr></thead>
              <tbody>
                {data.map((u) => (
                  <tr key={u.id}>
                    <td><div className="flex items-center gap-2"><span className="avatar">{initials(u.full_name)}</span><span className="fw-600">{u.full_name}</span>{u.id === me.id && <Badge tone="muted">You</Badge>}</div></td>
                    <td>{u.email}</td>
                    <td><Badge tone={u.role === 'admin' ? 'brand' : 'muted'}>{u.role}</Badge></td>
                    <td className="text-muted text-sm">{fmtDateTime(u.created_at)}</td>
                    <td className="col-actions"><button className="btn btn-ghost btn-sm" onClick={() => setEditing(u)}><Icon name="edit" /> Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <UserForm user={editing === 'new' ? undefined : editing} isMe={editing !== 'new' && editing.id === me.id} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
    </>
  );
}

function UserForm({ user, isMe, onClose, onSaved }: { user?: User; isMe: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ full_name: user?.full_name ?? '', email: user?.email ?? '', role: (user?.role ?? 'dispatcher') as Role, password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (user) {
        const body: Record<string, unknown> = { full_name: f.full_name, role: f.role };
        if (f.password) body.password = f.password;
        await staffApi(`/users/${user.id}`, { method: 'PATCH', body });
      } else {
        await staffApi('/users', { method: 'POST', body: f });
      }
      onSaved();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? (err.status === 409 ? 'That email already has an account' : err.message) : 'Could not save');
    }
  };

  return (
    <Modal title={user ? `Edit ${user.full_name}` : 'Add staff user'} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" form="user-form" className="btn btn-primary">{user ? 'Save changes' : 'Add user'}</button>
    </>}>
      <form id="user-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Full name" error={errors.full_name}><input className="form-control" required value={f.full_name} onChange={set('full_name')} autoFocus /></Field>
        <Field label="Email" error={errors.email}><input className="form-control" type="email" required disabled={!!user} value={f.email} onChange={set('email')} /></Field>
        <div className="form-row">
          <Field label="Role">
            <select className="form-control" value={f.role} onChange={set('role')} disabled={isMe}>
              <option value="dispatcher">Dispatcher</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Field label={user ? 'New password (optional)' : 'Password'} error={errors.password} hint="At least 8 characters">
            <input className="form-control" type="password" autoComplete="new-password" required={!user} minLength={8} value={f.password} onChange={set('password')} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
