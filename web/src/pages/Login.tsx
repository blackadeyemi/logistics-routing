import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ErrorAlert, Mark, SettingsMenu } from '../components/ui';
import { ApiError } from '../lib/api';
import { useStaffAuth } from '../lib/auth';

export function Login() {
  const { user, login } = useStaffAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-brand"><Mark size={40} /><span>Logistics Routing</span></div>
      <div className="auth-settings"><SettingsMenu /></div>
      <div className="auth-shell">
        <form className="auth-card" onSubmit={submit}>
          <h1>Dispatcher sign in</h1>
          <p className="subtitle">Plan routes, assign drivers and follow every delivery.</p>
          <ErrorAlert error={error} />
          <div className="form-group">
            <label className="form-label" htmlFor="email">Email</label>
            <input id="email" className="form-control" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="password">Password</label>
            <input id="password" className="form-control" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="auth-foot">Driver? <a href="/driver">Open the driver app</a></p>
      </div>
    </div>
  );
}
