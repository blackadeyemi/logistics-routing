# web

Dispatcher dashboard (`/`) and driver PWA (`/driver`) for Logistics Routing.
React, Vite, TypeScript, styled with the GDS design language
(`src/styles/gds.css`).

```sh
npm install
npm run dev        # http://localhost:5173, proxies /api to api-node
npm run build      # type check and production build with service worker
npm run preview    # serve the build, to test install and offline mode
npm run icons      # regenerate PNG app icons from public/mark.svg
```

`/api` goes to `localhost:API_HOST_PORT` from the root `.env`. Set
`API_PROXY_TARGET` to send it somewhere else.

## Local address

With `npm run dev` running, open http://logistics-routing.test. Laragon's
Apache proxies it to Vite on port 5173, websockets included, so hot reload
works. The vhost is `C:\laragon\etc\apache2\sites-enabled\logistics-routing.test.conf`
(no `auto.` prefix, so Laragon keeps it) and needs `mod_proxy`,
`mod_proxy_http` and `mod_proxy_wstunnel` enabled in `httpd.conf`.
http://localhost:5173 still works too.

Browsers only allow service workers on https or localhost, so test install
and offline mode with `npm run preview` on http://localhost:4173.

## Google Maps

An admin pastes the browser key on **Settings** (`/settings`). It is stored
in api-node (`app_settings` table) and every staff browser picks it up after
login. **Test key** checks it against Places API (New) from the browser, so
referrer and API restrictions show up before saving. `VITE_GOOGLE_MAPS_API_KEY`
in the root `.env` still works as a fallback when nothing is saved.

In Google Cloud, enable the Maps JavaScript API and Places API (New), and
restrict the key by HTTP referrer to the local addresses and the production
domain. The map ID is optional, `DEMO_MAP_ID` is used otherwise. Changing a
key that is already loaded needs a page reload, the Settings page offers it.

- Order form: address search limited to Nigeria and biased to Lagos.
  Picking a suggestion fills the coordinates and shows a preview map.
- Order detail and route planner: Google map with numbered pickup and
  dropoff pins joined in visiting order (straight lines, not roads).
- Driver app: unchanged, Navigate opens the Google Maps app. It needs to
  work offline, so it does not embed a map.

With no key, or if Google rejects it, the app uses typed coordinates and
the SVG route sketch, so nothing breaks.

## Layout

- `src/pages/` dispatcher screens: dashboard, orders, routes and the route
  planner, drivers, vehicles, staff users
- `src/driver/` the driver PWA. `store.ts` holds the offline logic: the
  day's route is cached, taps apply locally with the same rules as the API
  and are queued with their tap time and a unique id, then sent when online
- `src/lib/` API client, auth, theme, formatting, types
- `src/components/` shared GDS components
