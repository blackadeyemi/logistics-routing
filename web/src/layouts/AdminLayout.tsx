import { useCallback, useEffect, useRef, useState } from 'react';
import { startLive, stopLive, useLiveEvents, type LiveEvent } from '../lib/live';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon';
import { Mark, NetStatus, SettingsMenu, useClickOutside } from '../components/ui';
import { CopilotPanel } from '../copilot/CopilotPanel';
import { staffApi } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { configureMaps } from '../lib/maps';
import type { AppSettings } from '../lib/types';
import { fmtClock, initials } from '../lib/format';

interface NavItem { to: string; label: string; icon: IconName; adminOnly?: boolean }

const OPERATIONS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/live', label: 'Live map', icon: 'navigate' },
  { to: '/orders', label: 'Orders', icon: 'orders' },
  { to: '/routes', label: 'Routes', icon: 'routes' },
  { to: '/knowledge', label: 'Knowledge', icon: 'book' },
];
const FLEET: NavItem[] = [
  { to: '/drivers', label: 'Drivers', icon: 'drivers' },
  { to: '/vehicles', label: 'Vehicles', icon: 'vehicles' },
];
const ADMIN: NavItem[] = [
  { to: '/users', label: 'Staff users', icon: 'users', adminOnly: true },
  { to: '/settings', label: 'Settings', icon: 'settings', adminOnly: true },
];

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Dashboard'],
  [/^\/live/, 'Live map'],
  [/^\/messages/, 'Customer SMS'],
  [/^\/orders\/\d+/, 'Order'],
  [/^\/orders/, 'Orders'],
  [/^\/routes\/optimize/, 'Optimize'],
  [/^\/routes\/\d+/, 'Route planner'],
  [/^\/routes/, 'Routes'],
  [/^\/drivers/, 'Drivers'],
  [/^\/vehicles/, 'Vehicles'],
  [/^\/users/, 'Staff users'],
  [/^\/knowledge/, 'Knowledge'],
  [/^\/settings/, 'Settings'],
];

// Collapsed by default, as in GDS, so tables get the width.
const COLLAPSE_KEY = 'lr_sidebar_collapsed';
function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) !== '0';
  } catch {
    return true;
  }
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="clock">{fmtClock(now)}</span>;
}

function UserMenu() {
  const { user, logout } = useStaffAuth();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));
  if (!user) return null;
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="user-chip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="avatar">{initials(user.full_name)}</span>
        <span className="who">{user.full_name}</span>
      </button>
      {open && (
        <div className="dropdown-menu">
          <div className="dropdown-item" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
            <strong style={{ color: 'var(--ink)' }}>{user.full_name}</strong>
            <span className="text-xs text-muted">{user.email} · {user.role}</span>
          </div>
          <div className="dropdown-sep" />
          <a className="dropdown-item" href="/driver" target="_blank" rel="noreferrer"><Icon name="external" /> Open driver app</a>
          <button type="button" className="dropdown-item" onClick={logout}><Icon name="logout" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

export function AdminLayout() {
  const { user, ready } = useStaffAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  // The Google Maps key is set by an admin on the Settings page. Without
  // it (or offline) maps stay off and the fallbacks are used.
  useEffect(() => {
    if (!user) return;
    staffApi<AppSettings>('/settings')
      .then((s) => configureMaps({ key: s.google_maps.api_key, mapId: s.google_maps.map_id }))
      .catch(() => { /* keep the .env fallback */ });
  }, [user]);

  // Live updates: one WebSocket while signed in. Any change to routes,
  // stops or orders refreshes the data on screen (quietly, debounced), so
  // pages follow the drivers without anyone pressing reload.
  useEffect(() => {
    if (!user) return undefined;
    startLive();
    return stopLive;
  }, [user]);
  const refreshTimer = useRef<number | undefined>(undefined);
  const onLive = useCallback((e: LiveEvent) => {
    if (e.type === 'location' || e.type === 'hello') return;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => window.dispatchEvent(new CustomEvent('data:changed')), 600);
  }, []);
  useLiveEvents(onLive);

  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  const toggle = () => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setMobileOpen((o) => !o);
      return;
    }
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* not remembered */ }
      return !c;
    });
  };

  const title = TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? '';
  const section = (heading: string, items: NavItem[]) => {
    const visible = items.filter((i) => !i.adminOnly || user.role === 'admin');
    if (!visible.length) return null;
    return (
      <>
        <div className="nav-section">{heading}</div>
        {visible.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} title={collapsed ? i.label : undefined}>
            <Icon name={i.icon} />
            <span className="label">{i.label}</span>
          </NavLink>
        ))}
      </>
    );
  };

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}>
      <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Mark />
          <div className="brand-text">
            <strong>Logistics Routing</strong>
            <span>Dispatch console</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          {section('Operations', OPERATIONS)}
          {section('Fleet', FLEET)}
          {section('Admin', ADMIN)}
        </nav>
        <div className="sidebar-foot"><span className="ver">v0.1<span className="label"> · Phase 1</span></span></div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button type="button" className="menu-toggle" onClick={toggle} aria-label="Toggle menu"><Icon name="menu" /></button>
          <div>
            <div className="page-title">{title}</div>
            <div className="breadcrumb">Dispatch / {title}</div>
          </div>
          <div className="topbar-right">
            <button type="button" className={`btn btn-ghost btn-sm copilot-toggle${copilotOpen ? ' active' : ''}`} onClick={() => setCopilotOpen((o) => !o)} aria-expanded={copilotOpen}>
              <Icon name="sparkle" /> <span className="label">Copilot</span>
            </button>
            <Clock />
            <NetStatus />
            <SettingsMenu />
            <UserMenu />
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      <CopilotPanel open={copilotOpen} onClose={() => setCopilotOpen(false)} />
    </div>
  );
}
