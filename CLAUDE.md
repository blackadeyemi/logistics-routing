# Logistics Routing MVP

## What this is
A micro-SaaS logistics routing and dispatch system for small and mid-sized
Nigerian courier and delivery operators. Target user: someone currently
dispatching drivers via WhatsApp or phone calls who wants a real dashboard.

## Stack
- api-node: Express, main API, auth, dispatch logic. The only service the
  browser talks to.
- service-python: FastAPI, internal only. Holds the AI layer (Phase 2) and
  route optimization with OR-Tools (Phase 3).
- Postgres with PostGIS for spatial data. pgvector is added in Phase 2.
- web: React, Vite and TypeScript. The dispatcher dashboard at `/` and the
  driver PWA at `/driver` (vite-plugin-pwa). Calls the API through `/api`,
  which Vite proxies to api-node in development.
- Maps: Google Maps JavaScript API in the web app. Places API (New) for
  address search on orders, maps with numbered stops on the order detail
  and route planner. The browser key (referrer restricted) is set by an
  admin on the Settings page and stored in `app_settings`, with
  `VITE_GOOGLE_MAPS_API_KEY` in the root .env as a fallback; without a key the app falls back to typed coordinates
  and an SVG sketch. Loader in `web/src/lib/maps.ts`, components in
  `web/src/components/maps.tsx`.
- LLM: Claude via the official `anthropic` Python SDK. An admin sets the
  Anthropic API key and picks the model on the Settings page. api-node
  stores the key encrypted (AES-256-GCM, `SETTINGS_ENCRYPTION_KEY` in
  .env), never returns it to a browser, and passes key and model to
  service-python per request. `ANTHROPIC_API_KEY` and `LLM_MODEL` in .env
  are the fallback. Model IDs are never hardcoded in request code.

## UI design
The web app follows the GDS design language (the same look the Sports Club
app uses). Tokens and components are ported in `web/src/styles/gds.css`
with GDS class names: Inter, light/dark/system theme, small/medium/large
text, collapsible navy sidebar, sticky top bar, KPI stat tiles, left-bordered
alert cards, blue to teal gradient accents. App-specific screens go in
`web/src/styles/app.css` and reuse those tokens. Do not introduce a second
visual language or a CSS framework.

## Running locally
- `docker compose up -d` starts Postgres (custom image with pgvector, see
  db/Dockerfile), api-node and service-python (API on
  `API_HOST_PORT`, 3100 on this machine because 3000 is taken).
- `docker compose exec api-node npm run seed` loads demo Lagos data, add
  `-- --reset` to wipe first. Logins: dispatcher@example.com or
  admin@example.com with password123; drivers 08020000001 to 08020000005
  with PIN 1234.
- `cd api-node && npm test` runs API tests against throwaway databases.
- Evals (real model calls, cost money except retrieval):
  `docker compose exec service-python python -m evals.run_extraction`,
  `... evals.run_agent` (needs a freshly seeded day) and
  `... evals.run_retrieval` (free, local embeddings).
- `docker compose exec api-node npm run simulate` drives today's routes
  (positions and taps) so the live map, ETAs and SMS can be seen working.
- Optimizer benchmark (free): `npm run seed -- --reset --manual-day`, then
  `docker compose exec service-python python -m evals.run_optimizer`.
- `cd web && npm run dev` serves the app on http://logistics-routing.test
  (Laragon Apache proxies it to Vite on 5173, see web/README.md) or
  http://localhost:5173.
  `npm run build && npm run preview` tests the real service worker, which
  is off in dev.

## Current phase: Phase 4 (complete)
Phases 1 to 4 are complete (exit criteria met, evals and benchmarks in the
README). Background location on a real phone was measured: about 10%
coverage while the driver app is off screen, 100% on screen (README).
Phase 5 starts only when the user says so.
Build only what the current phase lists. Do not start work from a later
phase until told to move to it. Each phase is done when its exit criteria
are met.

## Roadmap

### Phase 1: Manual dispatch
Goal: replace WhatsApp and phone dispatch with a working dashboard.

Build:
- Auth (dispatcher and admin login, JWT)
- CRUD for drivers, vehicles, orders
- Manual route assignment (dispatcher assigns stops to a driver by hand,
  no optimization)
- Driver app as a PWA (installable from the browser, no app store),
  showing today's stops in assigned order:
  - Web app manifest and service worker so drivers can add it to their
    home screen.
  - Today's route cached so it stays readable with no network.
  - Status updates made offline are queued and sent when the connection
    returns, keeping the time the driver tapped as the event time.
- Status updates on a stop: picked up, en route, delivered, with timestamps
- Seed script with realistic Lagos data (drivers, vehicles, orders with
  real coordinates) so later phases have something to work against

Exit criteria:
- A dispatcher can create orders, build a route for a driver, and the
  driver can complete every stop from the installed PWA, including
  while briefly offline.
- api-node endpoints are documented well enough for Phase 2 tools to call.

### Phase 2: AI layer
Goal: an LLM-powered dispatch assistant built on FastAPI, covering
structured extraction, tool-using agents, and RAG, with measured quality.

Build:
- Order intake from free text: paste a WhatsApp message, get a validated
  draft order (customer name, phone, pickup, dropoff, notes) using
  structured output with Pydantic validation. Dispatcher reviews before
  saving. Nigerian phone numbers normalised to +234 format.
- Dispatch copilot agent: a chat panel in the dashboard. The agent answers
  questions and acts through tools that wrap api-node endpoints, for
  example `list_drivers`, `list_orders`, `get_route`, `create_order_draft`,
  `assign_stops`, `update_stop_status`.
  - Read tools run directly.
  - Write tools never execute on their own. They return a proposed change
    that the dispatcher confirms in the UI, then api-node applies it.
  - Every proposal and confirmation is written to an `agent_actions` audit
    table (who, prompt, tool, arguments, result, confirmed or rejected).
- RAG over delivery knowledge with pgvector:
  - Driver notes on stops (landmark directions, gate codes, "call on
    arrival") and company SOP documents, chunked and embedded.
  - Used by the copilot as a `search_knowledge` tool, with sources cited in
    the answer.
- Evals, kept in the repo and runnable with one command:
  - Extraction set: at least 30 real-style WhatsApp messages with expected
    fields, scored per field.
  - Agent scenarios: at least 15 tasks checking the right tools were
    called with the right arguments, and that writes were only proposed.
  - Retrieval set: questions with known source chunks, scored on recall.
  - Results table in the README.

Architecture rules:
- Browser calls api-node, api-node checks auth and proxies to
  service-python (`/ai/extract-order`, `/ai/chat`). service-python stays
  unexposed.
- service-python calls api-node for data and writes, passing the user's
  identity through, so the agent can never do more than the logged-in user.
- Streaming responses for the chat panel. Token usage logged per request.

Schema additions:
- `CREATE EXTENSION vector`, which needs a custom Postgres image built on
  `postgis/postgis:16-3.4` with `postgresql-16-pgvector` installed.
- `stops.notes` text column for driver notes.
- `knowledge_chunks` (source type, source id, content, embedding,
  created_at).
- `agent_actions` audit table.

Exit criteria:
- A dispatcher can turn a WhatsApp message into an order and build a day's
  routes through the copilot, confirming each write.
- Evals run green and the scores are published in the README.

### Phase 3: Route optimization
Goal: suggest efficient stop orders and driver assignments instead of
relying on the dispatcher's judgement.

Build:
- OR-Tools vehicle routing in service-python: pickup before dropoff for
  the same order, vehicle capacity in kg, optional delivery time windows.
- Distance matrix from PostGIS straight-line distances for now, behind an
  interface so Phase 5 can swap in real road distances.
- "Optimize" action in the dashboard that proposes routes, with a side by
  side comparison against the manual plan (total distance, stops per
  driver). Dispatcher accepts or edits.
- Exposed to the copilot as a `propose_optimized_routes` tool.

Exit criteria:
- For a seeded day of orders, the optimizer returns valid routes in under
  10 seconds and beats the manual plan on total distance.

### Phase 4: Live tracking and real time updates
Goal: dispatchers see where drivers are, and customers know when to
expect delivery.

Build:
- Driver location from the PWA via the browser Geolocation API, sent at
  a fixed interval while a route is in progress. Browsers pause location
  when the screen is off or the app is in the background; measure how
  much that hurts in practice, since it is the main trigger for Phase 7.
- `driver_locations` table storing recent points.
- WebSocket channel from api-node to the dashboard for driver positions
  and stop status changes.
- Live map in the dashboard.
- ETA per remaining stop, recalculated as the driver moves.
- Customer notification by SMS with a public tracking link per order.

Exit criteria:
- A dispatcher sees driver movement and status changes on the map without
  refreshing, and a customer can open a tracking link.

### Phase 5: Traffic-aware routing
Goal: plan on real roads and realistic travel times.

Build:
- Self-hosted OSRM in docker-compose, using the Nigeria OpenStreetMap
  extract, with a documented refresh process.
- Road distance and duration matrix from OSRM feeding the Phase 3
  optimizer.
- Time of day travel profiles learned from Phase 4 location history, to
  adjust durations for Lagos rush hours.
- Turn-by-turn route geometry shown on the driver view.

Exit criteria:
- Optimized routes and ETAs use road distances, and ETA error is measured
  against actual delivery timestamps.

### Phase 6: Multi-tenant SaaS and billing
Goal: sell the product to multiple courier companies.

Build:
- `tenants` table and `tenant_id` on every business table, enforced with
  Postgres row level security.
- Company signup and onboarding, inviting dispatchers and drivers.
- Subscription billing with Paystack, plan limits on drivers or orders per
  month.
- Per-tenant isolation for knowledge chunks and agent actions.
- Admin view for usage and LLM cost per tenant.

Exit criteria:
- Two companies can use the system side by side with no data visible
  across tenants, and billing renews automatically.

### Phase 7: Native driver app
Goal: replace the PWA with a native driver app where the browser falls
short, mainly background location and reliable notifications.

Build:
- React Native with Expo, calling the same api-node endpoints the PWA
  uses, so no backend changes are needed beyond push token storage.
- Background location tracking while a route is in progress, with
  battery-friendly intervals.
- Push notifications for new assignments and route changes.
- Offline queue carried over from the PWA behaviour.
- Camera for proof of delivery photos and signature capture.
- Android first (most Nigerian drivers), iOS after. Distributed through
  the Play Store, with an internal testing track before release.

Exit criteria:
- Drivers can run a full day with the screen off and the dashboard still
  shows their position, and the PWA is retired or kept as a fallback.

## Database notes
- PostGIS is enabled from day one so schema does not need to migrate later,
  even though Phase 1 does not run spatial queries yet.
- Locations are stored as GEOGRAPHY(POINT, 4326).
- See db/init/001_schema.sql for the initial table definitions.
- Later phases add tables through new numbered files in db/init or a
  migration tool chosen at that point. Do not edit 001 for new features.

## Conventions
- Postgres uses `$1, $2` style placeholders, not `?`.
- No em dashes or double hyphens in code comments, docs, or commit messages.
  Use commas, colons, or separate sentences instead.
- Keep the Python service stateless and callable only from api-node; it
  should not be exposed publicly.
- Secrets live in `.env` (listed without values in `.env.example`) or, for
  the ones an admin manages in the app such as the Anthropic API key,
  encrypted in `app_settings`. Server secrets are write-only from the UI:
  the API returns at most a masked hint, never the value.
