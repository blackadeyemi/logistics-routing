import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { onProgress } from '../lib/api';
import { getFont, getTheme, setFont, setTheme, type FontSize, type ThemeMode } from '../lib/theme';
import { ORDER_STATUS, ROUTE_STATUS, STOP_STATUS } from '../lib/format';
import type { OrderStatus, RouteStatus, StopStatus } from '../lib/types';

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function OrderBadge({ status }: { status: OrderStatus }) {
  const s = ORDER_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
export function RouteBadge({ status }: { status: RouteStatus }) {
  const s = ROUTE_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
export function StopBadge({ status }: { status: StopStatus }) {
  const s = STOP_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal-card${wide ? ' modal-card-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {children}
      {error ? <div className="form-error">{error}</div> : hint ? <div className="form-hint">{hint}</div> : null}
    </div>
  );
}

export function ErrorAlert({ error, extra }: { error: string | null; extra?: string[] }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      {error}
      {extra && extra.length > 0 && <ul>{extra.map((m, i) => <li key={i}>{m}</li>)}</ul>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card-pad">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skel" style={{ width: `${90 - i * 12}%`, marginBottom: 14 }} />
      ))}
    </div>
  );
}

/** The GDS gradient bar along the top of the page while requests run. */
export function ProgressBar() {
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(0);
  useEffect(() => onProgress(setBusy), []);
  useEffect(() => {
    if (!busy) {
      setWidth(100);
      const t = window.setTimeout(() => setWidth(0), 300);
      return () => window.clearTimeout(t);
    }
    setWidth(20);
    const t = window.setInterval(() => setWidth((w) => Math.min(90, w + (90 - w) * 0.15)), 200);
    return () => window.clearInterval(t);
  }, [busy]);
  return <div id="gds-progress" className={busy || (width > 0 && width < 100) ? 'active' : ''} style={{ width: `${width}%` }} />;
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export function NetStatus() {
  const online = useOnline();
  return (
    <span className={`net-status${online ? '' : ' offline'}`} title={online ? 'Online' : 'Offline'}>
      <span className="net-dot" />
      <span className="net-label">Offline</span>
    </span>
  );
}

export function useClickOutside<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/** Theme and text size, the GDS appearance popover. */
export function AppearanceControls() {
  const [theme, setThemeState] = useState<ThemeMode>(getTheme);
  const [font, setFontState] = useState<FontSize>(getFont);
  const pickTheme = (m: ThemeMode) => { setTheme(m); setThemeState(m); };
  const pickFont = (f: FontSize) => { setFont(f); setFontState(f); };
  return (
    <>
      <h4>Theme</h4>
      <div className="seg">
        <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => pickTheme('light')}><Icon name="sun" /> Light</button>
        <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => pickTheme('dark')}><Icon name="moon" /> Dark</button>
        <button type="button" className={theme === 'system' ? 'active' : ''} onClick={() => pickTheme('system')}><Icon name="monitor" /> Auto</button>
      </div>
      <h4>Text size</h4>
      <div className="seg">
        <button type="button" className={font === 'small' ? 'active' : ''} onClick={() => pickFont('small')} aria-label="Small text"><span className="fs-s">A</span></button>
        <button type="button" className={font === 'medium' ? 'active' : ''} onClick={() => pickFont('medium')} aria-label="Medium text"><span className="fs-m">A</span></button>
        <button type="button" className={font === 'large' ? 'active' : ''} onClick={() => pickFont('large')} aria-label="Large text"><span className="fs-l">A</span></button>
      </div>
    </>
  );
}

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="icon-btn" aria-label="Appearance" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="settings" />
      </button>
      {open && <div className="dropdown-menu settings-pop"><AppearanceControls /></div>}
    </div>
  );
}

export function Mark({ size = 32 }: { size?: number }) {
  return <img src="/mark.svg" alt="" width={size} height={size} />;
}
