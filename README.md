# Logistics Routing

Dispatch software for small and mid-sized courier companies in Nigeria.
It replaces the usual setup, where a dispatcher sends each driver their
jobs over WhatsApp and phone calls, with a web dashboard and an
installable driver app that keeps working when the network drops.

The project is being built in phases, from manual dispatch up to an
LLM-powered dispatch assistant, route optimization and live tracking.
**Phase 1, manual dispatch, is done**, including a full driver day on a real Android phone with part of it offline. Phase 2, the AI layer, is next.

| Dispatcher dashboard | Driver app (PWA) |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | <img src="docs/screenshots/driver-app.png" width="260" alt="Driver app"> |

![Route planner](docs/screenshots/route-planner.png)

## What it does today

**Dispatchers** (web dashboard)
- Create orders with customer details, pickup and dropoff. With a Google
  Maps key, addresses come from Places search and fill the coordinates.
- Plan each driver's day by hand: add orders to a route, drag stops into
  order, and get warned about a dropoff placed before its pickup. The
  planner shows straight-line distance and a map of the route.
- Follow every order through a timeline built from the driver's updates.
- Manage drivers (with app PINs), vehicles and staff accounts. Admins set
  the Google Maps key from the Settings page.

**Drivers** (installable PWA at `/driver`, no app store)
- Log in with phone number and PIN and see today's stops in order, with
  call and navigate buttons.
- Mark stops arrived, picked up, en route, delivered, or failed.
- Keep working offline. The route is cached on the phone, and taps are
  queued with the time they happened and sent when the connection is back.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    D[Dispatcher dashboard]
    P[Driver PWA<br/>offline cache and queue]
  end
  D -- /api --> A
  P -- /api --> A
  A[api-node<br/>Express, auth, dispatch rules] --> DB[(Postgres + PostGIS)]
  A -. Phase 2 .-> S[service-python<br/>FastAPI, Claude, OR-Tools]
  S -. reads and proposes writes via .-> A
```

- **web**: React, TypeScript and Vite. One app serves the dashboard at `/`
  and the driver PWA at `/driver` (vite-plugin-pwa, Workbox).
- **api-node**: Express API, the only service the browser talks to. JWT
  auth for staff and drivers, zod validation, Postgres through `pg`.
- **Postgres with PostGIS**: locations stored as `GEOGRAPHY(POINT, 4326)`
  from day one, so the optimizer and live tracking need no migration.
- **service-python**: FastAPI, internal only, never exposed. It will hold
  the AI layer and route optimization.

### Design decisions worth a look

- **Offline updates are safe to retry.** Each tap carries a
  `client_event_id`, so a resend after a dropped connection is a no-op.
  The tap time is kept as the event time, and it's clamped in SQL so a
  phone with a wrong clock can't put events before the order's last one.
- **The same rules run on the phone and the server.** The driver app
  applies a tap locally with the API's rules, such as no dropoff before
  pickup, so the screen stays right while offline. The server checks the
  same rules again when the tap arrives.
- **Order and route status are derived.** Drivers only change stops. The
  order's status (assigned, picked up, en route, delivered) and the route's
  status follow from them, so the two can't disagree.
- **Tests get throwaway databases.** Each test file builds its own Postgres
  database from `db/init` and drops it afterwards, so tests can't touch dev
  data and test files can run in parallel.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Manual dispatch | Auth, CRUD, manual routes, offline driver PWA, Lagos seed data | Done, tested on a Pixel 7 Pro (install, offline queue, sync) |
| 2. AI layer | WhatsApp message to validated order (Pydantic structured output), dispatch copilot agent with tool calls and human confirmation of every write, RAG over driver notes and SOPs with pgvector, evals in the repo | In progress |
| 3. Route optimization | OR-Tools vehicle routing with pickup before dropoff, capacity and time windows, compared against the manual plan | Planned |
| 4. Live tracking | Driver location, WebSocket updates, live map, ETAs, customer SMS tracking link | Planned |
| 5. Traffic-aware routing | Road distances and durations, Lagos rush-hour profiles | Planned |
| 6. Multi-tenant SaaS | Row level security per company, Paystack billing | Planned |
| 7. Native driver app | React Native (Expo) for background location and push | Planned |

The full scope and exit criteria for every phase are in [CLAUDE.md](CLAUDE.md).

## Run it locally

Needs Docker and Node 22.

```sh
cp .env.example .env          # set JWT_SECRET to a long random string
docker compose up -d          # Postgres, api-node, Python placeholder
docker compose exec api-node npm run seed    # demo Lagos data

cd web
npm install
npm run dev                   # http://localhost:5173, /api goes to API_HOST_PORT
```

Demo logins:
- **Dashboard:** `dispatcher@example.com` or `admin@example.com`, password `password123`.
- **Driver app** at `/driver`: `08020000001` to `08020000005`, PIN `1234`.

Maps are optional. Without a key the app uses typed coordinates and a
route sketch. To turn maps on, sign in as admin and paste a Google Maps
browser key on the Settings page.

The service worker only runs in a production build, so test install and
offline mode with `npm run build && npm run preview`
(http://localhost:4173).

## Tests

```sh
docker compose up -d postgres
cd api-node && npm install && npm test
```

The API tests cover auth and roles, validation and phone normalisation,
the route rules, a full driver day with offline retries, the settings
endpoints (the Anthropic key is never returned and is stored encrypted),
and WhatsApp intake against a stand-in AI service.

## AI evals

The AI features are measured, not eyeballed. Each eval lives in
`service-python/evals/`, runs through the real stack (api-node auth,
service-python, Anthropic) with one command, and prints the table below.

### Order intake from WhatsApp

32 realistic messages a Lagos courier receives: English, Pidgin, Yoruba,
Igbo and Hausa greetings, forwarded chats, emojis, heavy typos, phone
numbers in five formats, two numbers in one message, returns, landmark-only
addresses, gate codes, cash on delivery, time windows, a message that tries
to override the rules, and a question that is not an order at all.

Each field is scored on its own: the name must match ignoring titles (Mrs,
Dr, Baba), the phone must be the exact `+234` number (or be flagged when
invalid), addresses and notes must contain the key terms (house number,
street, area, landmark, amount, gate code), and a field the message does
not mention must stay empty, so invented details count as failures.

| Field | Claude Sonnet 5.5 | Claude Opus 5.5 |
| --- | --- | --- |
| Customer name | 97% (31/32) | 100% (32/32) |
| Customer phone | 97% (31/32) | 100% (32/32) |
| Pickup address | 97% (31/32) | 100% (32/32) |
| Dropoff address | 97% (31/32) | 100% (32/32) |
| Pickup notes | 100% (15/15) | 100% (15/15) |
| Dropoff notes | 100% (18/18) | 100% (18/18) |
| **All fields** | **98% (157/161)** | **100% (161/161)** |
| Messages fully right | 31/32 | 32/32 |
| Median time per message | 2.6 s | 2.5 s |
| Cost of the 32-message run | $0.14 | $0.29 |

Run on 18 November 2026. Sonnet's four misses are one message whose
request failed: the reply ran on to the token cap and came back
unparseable, so every field of that message counts as wrong. The service
now caps the reply at 2,048 tokens and retries once, which turned the same
message into a pass on three reruns; the table above is from before that
change.

What changed between runs, and why: the first run scored 98% on both
models. Two misses were real (a house number read as "2 = to", and a price
question turned into a dropoff in Ibadan), so the prompt gained a rule for
each. One miss was the test's fault (a shop number in the address instead
of the notes, which is just as useful to a rider) and the case was relaxed.

```sh
docker compose exec service-python python -m evals.run_extraction --model claude-sonnet-5-5 --model claude-opus-5-5
docker compose exec service-python python -m evals.run_extraction --only pidgin   # one case, does not replace saved results
```

A full run costs about $0.14 on Sonnet 5.5. Results are saved to
`service-python/evals/results/`.

## Repository layout

```
api-node/         Express API (src/routes, scripts/seed.js, test/)
web/              React dashboard and driver PWA
service-python/   FastAPI service for Phase 2 and 3 (placeholder for now)
db/init/          Numbered SQL files, run in order on a fresh database
docs/             Screenshots
```

Endpoint reference: [api-node/README.md](api-node/README.md).
Web app notes: [web/README.md](web/README.md).
