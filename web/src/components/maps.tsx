import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { LAGOS, mapId, mapsEnabled, mapsLib, markerLib, placesLib } from '../lib/maps';
import type { LatLng } from '../lib/types';
import { Icon } from './Icon';

/** True while Google Maps can be used. Flips to false if Google rejects the key. */
export function useMapsEnabled() {
  const [on, setOn] = useState(mapsEnabled);
  useEffect(() => {
    const sync = () => setOn(mapsEnabled());
    window.addEventListener('lr-maps-failed', sync);
    window.addEventListener('lr-maps-config', sync);
    return () => {
      window.removeEventListener('lr-maps-failed', sync);
      window.removeEventListener('lr-maps-config', sync);
    };
  }, []);
  return on;
}

function useDarkTheme() {
  const read = () => document.documentElement.getAttribute('data-theme') === 'dark';
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// ---- Address search -------------------------------------------------------

export interface PickedPlace { address: string; location: LatLng }

interface Suggestion { id: string; main: string; secondary: string; prediction: google.maps.places.PlacePrediction }

/**
 * Address field with Google Places suggestions, limited to Nigeria and biased
 * to Lagos. Typing stays free text; picking a suggestion also fills the
 * coordinates. Without Maps it is a plain input.
 */
export function AddressInput({ value, onChange, onPick, disabled, required, placeholder }: {
  value: string;
  onChange: (text: string) => void;
  onPick: (p: PickedPlace) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  const enabled = useMapsEnabled();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const token = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const typed = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || !typed.current) return;
    const q = value.trim();
    if (q.length < 3) { setItems([]); return; }
    const n = ++seq.current;
    const t = window.setTimeout(async () => {
      try {
        const { AutocompleteSuggestion, AutocompleteSessionToken } = await placesLib();
        // One token per search, ended by the place lookup, so Google bills
        // the keystrokes and the lookup as a single session.
        token.current ??= new AutocompleteSessionToken();
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q,
          sessionToken: token.current,
          includedRegionCodes: ['ng'],
          locationBias: { center: LAGOS, radius: 50_000 },
          language: 'en',
        });
        if (n !== seq.current) return;
        setItems(suggestions.flatMap((s) => {
          const p = s.placePrediction;
          return p ? [{ id: p.placeId, main: p.mainText?.text ?? p.text.text, secondary: p.secondaryText?.text ?? '', prediction: p }] : [];
        }));
        setActive(0);
        setOpen(true);
      } catch {
        if (n === seq.current) setItems([]);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [value, enabled]);

  const pick = async (s: Suggestion) => {
    setOpen(false);
    setBusy(true);
    try {
      const place = s.prediction.toPlace();
      await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
      token.current = null;
      typed.current = false;
      const name = place.displayName ?? s.main;
      const formatted = place.formattedAddress ?? s.secondary;
      // "Ikeja City Mall, 194 Obafemi Awolowo Way, Ikeja" reads better for a
      // driver than the street address alone.
      const address = formatted.toLowerCase().includes(name.toLowerCase()) ? formatted : `${name}, ${formatted}`;
      if (place.location) onPick({ address, location: { lat: round(place.location.lat()), lng: round(place.location.lng()) } });
      else onChange(address);
    } catch {
      onChange(`${s.main}${s.secondary ? `, ${s.secondary}` : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); void pick(items[active]!); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="dropdown address-input">
      <input
        className="form-control"
        required={required}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role={enabled ? 'combobox' : undefined}
        aria-expanded={enabled ? open : undefined}
        aria-autocomplete={enabled ? 'list' : undefined}
        onChange={(e) => { typed.current = true; onChange(e.target.value); }}
        onKeyDown={onKey}
        onFocus={() => items.length && setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {busy && <span className="address-busy text-xs text-muted">Finding…</span>}
      {open && items.length > 0 && (
        <div className="dropdown-menu address-menu" role="listbox">
          {items.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`dropdown-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => void pick(s)}
            >
              <Icon name="dropoff" />
              <span className="address-opt">
                <strong>{s.main}</strong>
                {s.secondary && <span className="text-xs text-muted">{s.secondary}</span>}
              </span>
            </button>
          ))}
          <div className="address-attrib text-xs text-muted">Powered by Google</div>
        </div>
      )}
    </div>
  );
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

// ---- Map of stops ---------------------------------------------------------

export interface MapPoint {
  id: string | number;
  location: LatLng;
  kind: 'pickup' | 'dropoff';
  label: string;
  title: string;
  tone?: 'warn' | 'done';
}

/**
 * Google map with numbered pickup and dropoff pins, optionally joined in
 * visiting order by a straight line (not road geometry, that comes with
 * routing in a later phase).
 */
export function StopsMap({ points, line = true, height = 340, className = '' }: {
  points: MapPoint[];
  line?: boolean;
  height?: number;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const [ready, setReady] = useState(0);
  const [failed, setFailed] = useState(false);
  const dark = useDarkTheme();

  // The color scheme is fixed when a map is created, so a theme change
  // builds a new map.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { Map } = await mapsLib();
        if (cancelled || !el.current) return;
        map.current = new Map(el.current, {
          mapId: mapId(),
          center: LAGOS,
          zoom: 11,
          colorScheme: dark ? 'DARK' : 'LIGHT',
          disableDefaultUI: true,
          zoomControl: true,
          fullscreenControl: true,
          gestureHandling: 'cooperative',
          clickableIcons: false,
        });
        setReady((r) => r + 1);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; map.current = null; };
  }, [dark]);

  const key = JSON.stringify(points.map((p) => [p.id, p.location.lat, p.location.lng, p.label, p.kind, p.tone]));
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    let cancelled = false;
    const markers: google.maps.marker.AdvancedMarkerElement[] = [];
    let path: google.maps.Polyline | null = null;
    void (async () => {
      const [{ AdvancedMarkerElement }, { Polyline }] = await Promise.all([markerLib(), mapsLib()]);
      if (cancelled) return;
      // Stops at the same spot (two pickups at one mall) would hide each
      // other: fan repeats out in a small ring, as the sketch does.
      const seen = new Map<string, number>();
      for (const p of points) {
        const k = `${p.location.lat.toFixed(4)}:${p.location.lng.toFixed(4)}`;
        const n = seen.get(k) ?? 0;
        seen.set(k, n + 1);
        const pin = document.createElement('div');
        pin.className = `map-pin ${p.kind}${p.tone ? ` ${p.tone}` : ''}`;
        pin.textContent = p.label;
        if (n > 0) {
          const a = (n * Math.PI) / 3 - Math.PI / 2;
          pin.style.translate = `${Math.round(24 * Math.cos(a))}px ${Math.round(24 * Math.sin(a))}px`;
        }
        markers.push(new AdvancedMarkerElement({ map: m, position: p.location, content: pin, title: p.title }));
      }
      if (line && points.length > 1) {
        path = new Polyline({ map: m, path: points.map((p) => p.location), strokeColor: '#2ea6ff', strokeOpacity: 0.85, strokeWeight: 3, geodesic: true, clickable: false });
      }
      if (points.length === 1) {
        m.setCenter(points[0]!.location);
        m.setZoom(15);
      } else if (points.length > 1) {
        const b = new google.maps.LatLngBounds();
        for (const p of points) b.extend(p.location);
        m.fitBounds(b, 48);
      }
    })();
    return () => {
      cancelled = true;
      for (const mk of markers) mk.map = null;
      path?.setMap(null);
    };
    // points is captured through key, which changes only when what is drawn changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, line, ready]);

  if (failed) return <div className="pool-empty" style={{ padding: '2.5rem 1rem' }}>The map could not load. Check the network or the Google Maps key.</div>;
  return <div ref={el} className={`stops-map ${className}`} style={{ height }} role="region" aria-label="Map of stops" />;
}
