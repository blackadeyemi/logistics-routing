import { useEffect, useRef, useState } from 'react';
import { LAGOS, mapId, mapsLib, markerLib } from '../lib/maps';
import type { LatLng } from '../lib/types';
import { useDarkTheme, useMapsEnabled } from './maps';

// One colour per route, from the GDS palette, so a driver and their stops
// match on the map and in the list.
export const ROUTE_COLOURS = ['#1d6fd8', '#0fa3a3', '#d9731a', '#7c4dd8', '#c2185b', '#2e7d32', '#5d6b7a'];

export interface LiveDriver {
  route_id: number;
  colour: string;
  initials: string;
  name: string;
  location: (LatLng & { age_s?: number }) | null;
  stale: boolean;
  stops: { stop_id: number; n: number; type: 'pickup' | 'dropoff'; location: LatLng | null; done: boolean; title: string }[];
}

/**
 * Drivers and their stops on a Google map, or on a to-scale sketch when
 * there is no Maps key. Markers move in place as positions arrive, so the
 * map never reloads or loses the dispatcher's zoom.
 */
export function LiveMap({ drivers, focus, height = 560 }: { drivers: LiveDriver[]; focus: number | null; height?: number }) {
  const maps = useMapsEnabled();
  return maps ? <GoogleLiveMap drivers={drivers} focus={focus} height={height} /> : <SketchLiveMap drivers={drivers} focus={focus} height={height} />;
}

function GoogleLiveMap({ drivers, focus, height }: { drivers: LiveDriver[]; focus: number | null; height: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const [ready, setReady] = useState(0);
  const dark = useDarkTheme();
  const fitted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { Map } = await mapsLib();
      if (cancelled || !el.current) return;
      map.current = new Map(el.current, {
        mapId: mapId(), center: LAGOS, zoom: 11, colorScheme: dark ? 'DARK' : 'LIGHT',
        disableDefaultUI: true, zoomControl: true, fullscreenControl: true, clickableIcons: false,
      });
      fitted.current = false;
      setReady((r) => r + 1);
    })();
    return () => { cancelled = true; map.current = null; };
  }, [dark]);

  // Stops and route lines: rebuilt when the plan changes (not on every move).
  const planKey = JSON.stringify(drivers.map((d) => [d.route_id, d.colour, d.stops.map((s) => [s.stop_id, s.done])]));
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return undefined;
    let cancelled = false;
    const made: google.maps.marker.AdvancedMarkerElement[] = [];
    void (async () => {
      const { AdvancedMarkerElement } = await markerLib();
      if (cancelled) return;
      const bounds = new google.maps.LatLngBounds();
      for (const d of drivers) {
        for (const s of d.stops) {
          if (!s.location) continue;
          const pin = document.createElement('div');
          pin.className = `map-pin live ${s.type}${s.done ? ' done' : ''}`;
          pin.style.background = s.done ? '' : d.colour;
          pin.textContent = String(s.n);
          made.push(new AdvancedMarkerElement({ map: m, position: s.location, content: pin, title: s.title }));
          bounds.extend(s.location);
        }
        if (d.location) bounds.extend(d.location);
      }
      if (!fitted.current && !bounds.isEmpty()) {
        m.fitBounds(bounds, 48);
        fitted.current = true;
      }
    })();
    return () => { cancelled = true; made.forEach((mk) => { mk.map = null; }); };
    // drivers is captured through planKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, ready]);

  // Driver markers and the line to their remaining stops: updated in place.
  const driverMarkers = useRef(new Map<number, { marker: google.maps.marker.AdvancedMarkerElement; line: google.maps.Polyline }>());
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    void (async () => {
      const [{ AdvancedMarkerElement }, { Polyline }] = await Promise.all([markerLib(), mapsLib()]);
      const seen = new Set<number>();
      for (const d of drivers) {
        seen.add(d.route_id);
        let entry = driverMarkers.current.get(d.route_id);
        if (!d.location) {
          if (entry) { entry.marker.map = null; entry.line.setMap(null); driverMarkers.current.delete(d.route_id); }
          continue;
        }
        if (!entry) {
          const pin = document.createElement('div');
          pin.className = 'driver-pin';
          entry = {
            marker: new AdvancedMarkerElement({ map: m, position: d.location, content: pin, title: d.name, zIndex: 1000 }),
            line: new Polyline({ map: m, strokeOpacity: 0.7, strokeWeight: 3, clickable: false }),
          };
          driverMarkers.current.set(d.route_id, entry);
        }
        const pin = entry.marker.content as HTMLElement;
        pin.textContent = d.initials;
        pin.style.background = d.colour;
        pin.classList.toggle('stale', d.stale);
        entry.marker.position = d.location;
        entry.line.setOptions({ strokeColor: d.colour, path: [d.location, ...d.stops.filter((s) => !s.done && s.location).map((s) => s.location!)] });
      }
      for (const [id, entry] of driverMarkers.current) {
        if (!seen.has(id)) { entry.marker.map = null; entry.line.setMap(null); driverMarkers.current.delete(id); }
      }
    })();
  }, [drivers, ready]);

  useEffect(() => {
    const m = map.current;
    const d = drivers.find((x) => x.route_id === focus);
    if (m && d?.location) {
      m.panTo(d.location);
      if ((m.getZoom() ?? 0) < 13) m.setZoom(14);
    }
    // only when the dispatcher picks a driver
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  return <div ref={el} className="stops-map live-map" style={{ height }} role="region" aria-label="Live map of drivers and stops" />;
}

// Without Google Maps: the same picture to scale, like the route sketch.
function SketchLiveMap({ drivers, focus, height }: { drivers: LiveDriver[]; focus: number | null; height: number }) {
  const pts: LatLng[] = drivers.flatMap((d) => [...(d.location ? [d.location] : []), ...d.stops.flatMap((s) => (s.location ? [s.location] : []))]);
  if (pts.length < 2) return <div className="pool-empty" style={{ padding: '3rem 1rem' }}>Nothing to show yet: no stops with coordinates or driver positions today.</div>;
  const W = 760;
  const H = Math.round(W * (height / 760));
  const pad = 30;
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 0.005);
  const spanY = Math.max(maxLat - minLat, 0.005);
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const xy = (l: LatLng) => [offX + (l.lng - minLng) * kx * scale, H - offY - (l.lat - minLat) * scale] as const;
  return (
    <svg className="sketch live-sketch" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sketch of drivers and stops">
      {drivers.map((d) => {
        const rest = d.stops.filter((s) => !s.done && s.location).map((s) => xy(s.location!));
        const line = [...(d.location ? [xy(d.location)] : []), ...rest];
        const dim = focus !== null && focus !== d.route_id;
        return (
          <g key={d.route_id} opacity={dim ? 0.3 : 1}>
            {line.length > 1 && <polyline points={line.map((p) => p.join(',')).join(' ')} fill="none" stroke={d.colour} strokeWidth="2.5" strokeDasharray="5 4" />}
            {d.stops.map((s) => {
              if (!s.location) return null;
              const [x, y] = xy(s.location);
              return (
                <g key={s.stop_id} className={`sketch-pt ${s.type}${s.done ? ' done' : ''}`}>
                  <circle cx={x} cy={y} r="9" style={s.done ? undefined : { fill: d.colour }} />
                  <text x={x} y={y} dy="0.35em" textAnchor="middle">{s.n}</text>
                  <title>{s.title}</title>
                </g>
              );
            })}
            {d.location && (() => {
              const [x, y] = xy(d.location);
              return (
                <g className={`sketch-driver${d.stale ? ' stale' : ''}`}>
                  <circle cx={x} cy={y} r="14" style={{ fill: d.colour }} />
                  <text x={x} y={y} dy="0.35em" textAnchor="middle">{d.initials}</text>
                  <title>{d.name}</title>
                </g>
              );
            })()}
          </g>
        );
      })}
    </svg>
  );
}
