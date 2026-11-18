// Google Maps JavaScript API loader. The key is a browser key, so it ships
// to the browser by design: restrict it by HTTP referrer and to the Maps
// JavaScript and Places (New) APIs in the Google Cloud console.
// An admin sets it on the Settings page (stored in api-node); the
// VITE_GOOGLE_MAPS_API_KEY build variable is only a fallback.
// With no key the app falls back to typed addresses and the SVG sketch.
import type { LatLng } from './types';

const ENV_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() ?? '';
const ENV_MAP_ID = (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined)?.trim() ?? '';

let KEY = ENV_KEY;
let MAP_ID_VALUE = ENV_MAP_ID;
let loadedKey: string | null = null;
let failed = false;
let loading: Promise<void> | null = null;

/** The key Google's script was loaded with, or null if it has not loaded. */
export const loadedMapsKey = () => loadedKey;

// Advanced markers and the dark color scheme need a map ID. DEMO_MAP_ID works
// for development; create a real one in the console for production.
export const mapId = () => MAP_ID_VALUE || 'DEMO_MAP_ID';

/**
 * Apply the key from the server settings. Google's script cannot be
 * unloaded, so once it has loaded with one key a different key only takes
 * effect after a page reload.
 */
export function configureMaps(cfg: { key: string; mapId: string }) {
  const key = cfg.key.trim() || ENV_KEY;
  const id = cfg.mapId.trim() || ENV_MAP_ID;
  if (loadedKey !== null && key !== loadedKey) return;
  if (key === KEY && id === MAP_ID_VALUE) return;
  KEY = key;
  MAP_ID_VALUE = id;
  failed = false;
  window.dispatchEvent(new Event('lr-maps-config'));
}

// Bias address search to Lagos without excluding the rest of Nigeria.
export const LAGOS: LatLng = { lat: 6.5244, lng: 3.3792 };


export function mapsEnabled(): boolean {
  return !!KEY && !failed;
}

declare global {
  interface Window {
    __lrMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}

function load(): Promise<void> {
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    if (!KEY) { reject(new Error('Google Maps key not set')); return; }
    // Google calls this when the key is rejected (wrong referrer, API off,
    // billing missing). The page keeps working with the fallbacks.
    window.gm_authFailure = () => {
      failed = true;
      window.dispatchEvent(new Event('lr-maps-failed'));
    };
    window.__lrMapsReady = () => resolve();
    loadedKey = KEY;
    const s = document.createElement('script');
    const params = new URLSearchParams({ key: KEY, v: 'weekly', loading: 'async', callback: '__lrMapsReady', region: 'NG', language: 'en' });
    s.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    s.async = true;
    s.onerror = () => { failed = true; loading = null; reject(new Error('Could not load Google Maps')); };
    document.head.append(s);
  });
  return loading;
}

export async function mapsLib() {
  await load();
  return (await google.maps.importLibrary('maps')) as google.maps.MapsLibrary;
}
export async function markerLib() {
  await load();
  return (await google.maps.importLibrary('marker')) as google.maps.MarkerLibrary;
}
export async function placesLib() {
  await load();
  return (await google.maps.importLibrary('places')) as google.maps.PlacesLibrary;
}
