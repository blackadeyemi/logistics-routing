// Light, dark or system theme plus text size, as in GDS. index.html applies
// the saved choice before first paint so there is no flash.

export type ThemeMode = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';

const THEME_KEY = 'lr_theme';
const FONT_KEY = 'lr_font';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice just is not remembered.
  }
}

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function getTheme(): ThemeMode {
  const v = read(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}
export function getFont(): FontSize {
  const v = read(FONT_KEY);
  return v === 'small' || v === 'large' ? v : 'medium';
}

export function applyTheme(mode: ThemeMode = getTheme()) {
  const dark = mode === 'dark' || (mode === 'system' && media().matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', dark ? '#0b1120' : '#0f172a');
}
export function applyFont(size: FontSize = getFont()) {
  document.documentElement.setAttribute('data-font', size);
}

export function setTheme(mode: ThemeMode) {
  write(THEME_KEY, mode);
  applyTheme(mode);
}
export function setFont(size: FontSize) {
  write(FONT_KEY, size);
  applyFont(size);
}

// Follow the OS when the user picked "system".
export function watchSystemTheme() {
  const mq = media();
  const handler = () => {
    if (getTheme() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
