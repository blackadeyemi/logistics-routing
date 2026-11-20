# api-node

Main API for the dashboard and the driver PWA. Express, Postgres with
PostGIS, JWT auth.

## Run

```sh
cp .env.example .env               # from the repo root, set JWT_SECRET
docker compose up -d --build
docker compose exec api-node npm run seed            # demo Lagos data
docker compose exec api-node npm run seed -- --reset # wipe and reseed
```

The API listens on `API_HOST_PORT` (default 3000).

Seeded logins: `admin@example.com` and `dispatcher@example.com` with
password `password123`. Drivers `08020000001` to `08020000005` with PIN
`1234`.

## Test

Tests run from the host against the compose Postgres on localhost. Each
test file creates and drops its own database from `db/init`, so dev data
is never touched.

```sh
docker compose up -d postgres
cd api-node && npm install && npm test
```

Override the connection with `TEST_PG_HOST`, `TEST_PG_PORT`,
`TEST_PG_USER`, `TEST_PG_PASSWORD`.

## Conventions

- Send `Authorization: Bearer <token>` on every call except login.
- Locations are `{ "lat": 6.6142, "lng": 3.3581 }` or `null`.
- Phone numbers accept local formats (`0803 123 4567`) and are stored and
  returned as `+2348031234567`.
- Dates are `YYYY-MM-DD`. "Today" means today in Africa/Lagos.
- Errors are `{ "error": "message", "details": ... }`. 400 is invalid
  input, 401 no or bad token, 403 wrong role, 404 not found, 409 the
  request conflicts with current state (details list each problem).

## Endpoints

Roles: **staff** is admin or dispatcher, **admin** is admin only,
**driver** is a driver token.

### Auth

| Method | Path | Who | Body | Notes |
|---|---|---|---|---|
| POST | /auth/login | anyone | `email, password` | Returns `token, user` |
| POST | /auth/driver-login | anyone | `phone, pin` | Returns `token, driver` |
| GET | /auth/me | any token | | Current account |

Tokens last 12 hours.

### Users (admin)

| Method | Path | Body |
|---|---|---|
| GET | /users | |
| POST | /users | `email, password (8+), full_name, role?` |
| PATCH | /users/:id | `full_name?, role?, password?` |
| DELETE | /users/:id | |

### Vehicles (staff)

| Method | Path | Body or query |
|---|---|---|
| GET | /vehicles | `?status=active\|maintenance\|inactive` |
| GET | /vehicles/:id | |
| POST | /vehicles | `type (bike\|keke\|van\|truck), plate_number, capacity_kg?, status?` |
| PATCH | /vehicles/:id | any of the above |
| DELETE | /vehicles/:id | |

### Drivers (staff)

| Method | Path | Body or query |
|---|---|---|
| GET | /drivers | `?status=active\|inactive` |
| GET | /drivers/:id | |
| POST | /drivers | `name, phone, email?, vehicle_id?, status?, pin?` |
| PATCH | /drivers/:id | `name?, phone?, email?, vehicle_id?, status?` |
| PUT | /drivers/:id/pin | `pin` (4 to 6 digits) |
| DELETE | /drivers/:id | Refused once the driver has routes, set inactive |

Driver responses include `has_pin` and the assigned `vehicle`.

### Orders (staff)

| Method | Path | Body or query |
|---|---|---|
| GET | /orders | `?status=pending,assigned&q=lekki&date=YYYY-MM-DD&limit=50&offset=0` |
| GET | /orders/:id | Includes `events`, the order timeline |
| POST | /orders | `customer_name, customer_phone, pickup_address, pickup_location?, pickup_notes?, dropoff_address, dropoff_location?, dropoff_notes?, weight_kg? (default 1), dropoff_after?, dropoff_before?` (delivery window, Lagos time `HH:MM`, either end optional, `""` for none) |
| PATCH | /orders/:id | Any create field. Addresses lock once the driver starts that stop; notes can change any time and show on the stops (`notes`) in routes and the driver app |
| POST | /orders/:id/cancel | Only pending or assigned orders |

Creating an order also creates its two stops, returned as
`pickup_stop_id` and `dropoff_stop_id`.

Order status: `pending` (no route), `assigned`, `picked_up`, `en_route`,
`delivered`, `cancelled`.

### Routes (staff)

| Method | Path | Body or query |
|---|---|---|
| GET | /routes | `?date=YYYY-MM-DD&driver_id=1`, with `stop_count, done_count` |
| GET | /routes/:id | Route with ordered `stops` |
| POST | /routes | `driver_id, vehicle_id?, route_date?` |
| PATCH | /routes/:id | `driver_id?` (only before it starts), `vehicle_id?` |
| PUT | /routes/:id/stops | `stop_ids`: the full ordered list |
| POST | /routes/stops/:id/status | `action` (arrive, start, complete, skip): dispatch records a stop update for the driver, same rules as the driver app, recorded as done by staff |
| DELETE | /routes/:id | Only when no stop has started |

One route per driver per day. The vehicle defaults to the driver's.

`PUT /routes/:id/stops` is manual assignment. The list replaces the
route's stops in the order given. It is rejected with 409 when:

- a stop is already on another route
- an order's pickup and dropoff are not both on the route
- a dropoff comes before its pickup
- a stop the driver has started would be removed
- the order is cancelled or delivered

Orders added become `assigned`. Orders left out go back to `pending`.

Route status updates itself: `planned` until a stop starts,
`in_progress`, then `completed` when every stop is completed or skipped.

### Driver PWA (driver)

| Method | Path | Body or query |
|---|---|---|
| GET | /driver/route | `?date=YYYY-MM-DD`. Returns `{ route: null }` on a free day |
| POST | /driver/stops/:id/status | `action, occurred_at?, client_event_id?` |

Actions:

| Action | Stop | Effect |
|---|---|---|
| `arrive` | pending to arrived | |
| `start` | dropoff only | Order `picked_up` to `en_route` |
| `complete` | pending or arrived to completed | Pickup: order `picked_up`. Dropoff: order `delivered` |
| `skip` | pending or arrived to skipped | Pickup: the order leaves the route and goes back to `pending`. Dropoff: stays on the route as a failed delivery |

A dropoff cannot be arrived at, started or completed before its pickup is
completed.

Offline queue support:

- `occurred_at` is when the driver tapped (ISO 8601 with offset). It may
  be up to 48 hours old and is moved forward if it would come before the
  order's previous event.
- `client_event_id` (8 to 64 chars, unique per tap) makes retries safe.
  A repeat returns `replayed: true` and changes nothing. Repeating an
  action that already happened is also a no-op.

### Stats (staff)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/stats/today` | Counts for the dashboard, "today" in Africa/Lagos |

Response fields, all numbers except `date`:

- `date`: today, `YYYY-MM-DD`
- `pending`, `assigned`, `in_transit`: orders by status right now
  (`in_transit` is `picked_up` plus `en_route`)
- `created_today`, `delivered_today`: orders created, and orders
  delivered (by event time), today
- `failed_today`: dropoffs skipped on today's routes
- `routes_today`, `routes_in_progress`, `routes_completed`: today's routes
- `drivers_active`: active drivers; `drivers_free`: active drivers with no
  route today; `drivers_without_pin`: active drivers who cannot log in yet

### AI (staff)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/ai/extract-order` | Body `{ message }` (5 to 4000 chars). Returns a draft order read from a WhatsApp message. Saves nothing |

Response:

```json
{
  "draft": {
    "customer_name": "Chinedu Okeke", "customer_phone": "+2348034567890",
    "pickup_address": "23 Allen Avenue, Ikeja, opposite Mr Biggs", "pickup_notes": null,
    "dropoff_address": "5 Admiralty Way, Lekki Phase 1", "dropoff_notes": "Collect 15,000 naira on delivery. Call before arriving."
  },
  "phone_valid": true,
  "missing": [],
  "warnings": [],
  "model": "claude-sonnet-5-5",
  "usage": { "input_tokens": 1605, "output_tokens": 151, "duration_ms": 4286 }
}
```

- Any draft field can be null; `missing` lists the required order fields
  the message did not contain. The dispatcher completes them and saves
  through `POST /orders`.
- `customer_phone` is normalised to `+234…` when it is a Nigerian mobile
  number; otherwise it is returned as written, `phone_valid` is false and
  `warnings` says so.
- 409 with `details.code` `not_configured` when no key or model is set.
  422 `refusal` or `incomplete` when the model declines or returns no
  draft. Key and model errors are the same as `/settings/ai/check`.
- Every call is recorded in `ai_usage` (user, feature, model, tokens,
  duration, ok).

### Knowledge (staff)

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/knowledge/documents` | staff | SOP documents with their chunk counts |
| GET | `/knowledge/documents/:id` | staff | |
| POST | `/knowledge/documents` | admin | `title, body`. Body is Markdown; each `##` section becomes one chunk. Indexed before replying |
| PUT | `/knowledge/documents/:id` | admin | `title, body`. Re-indexed |
| DELETE | `/knowledge/documents/:id` | admin | Removes its chunks too |
| GET | `/knowledge/search` | staff | `?q=&limit=5&source=sop|stop_note`. Hybrid pgvector and full-text search; returns `id, source_type, source_id, title, content, similarity, score, order_id` |
| GET | `/knowledge/stats` | staff | `documents, sop_chunks, note_chunks` |
| POST | `/knowledge/reindex` | admin | Rebuilds every chunk |

Stop notes are indexed automatically after an order is created or its
notes or addresses change. Embeddings come from service-python's local
model, so search needs service-python running but no API key.

### Copilot (staff)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/ai/chat` | `conversation_id?, message`. Server-sent events: `start {conversation_id}`, `text {delta}`, `tool {id, name, label, status, input?, detail?}`, `proposal {action}`, `sources {items}`, `error {message}`, `done {conversation_id, usage}`. Admins may add `model` to override the Settings model for one turn |
| GET | `/ai/conversations` | Your last 20 conversations |
| GET | `/ai/conversations/:id` | `display` (what the panel shows) and `actions` (proposals with their status) |
| POST | `/ai/actions` | Used by service-python with the user's token: `conversation_id, prompt, tool, arguments`. Validates and previews a write, stores it as `proposed`, changes nothing else. 400/404/409 with a reason the agent can act on |
| POST | `/ai/actions/:id/confirm` | Applies a proposal through the public endpoints as the confirming user. Status becomes `confirmed` with `result`, or `failed` with `result.error`. A second confirm is 409 |
| POST | `/ai/actions/:id/reject` | Status `rejected`; nothing is applied |

Write tools the copilot can propose: `create_order`, `update_order`,
`cancel_order`, `assign_stops` (`driver_id, route_date?, stop_ids`: the
driver's whole stop list for the day, creating the route if needed),
`update_stop_status` (`stop_id, action`) and `propose_optimized_routes`
(`route_date?, keep_driver_ids?`: runs the optimizer when proposing, so
confirming applies exactly the plan that was shown). Only the user who owns the
conversation, or an admin, can see or decide its proposals. Each copilot
turn is logged in `ai_usage` with feature `copilot`.

### Optimizations (staff)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/optimizations` | `route_date?, keep_driver_ids?`. Runs the optimizer (about 5 s) and stores a proposal; changes no routes. 409 when there is nothing to plan or no free driver with a vehicle |
| GET | `/optimizations` | `?date=`. Recent runs |
| GET | `/optimizations/:id` | The run: `manual` (current routes and `summary`), `proposed` (routes with `stop_ids`, `stops` with `eta`, `distance_km`, `peak_load_kg`), `unassigned` (with a reason), `solve_ms`, `status` |
| POST | `/optimizations/:id/accept` | Applies the plan in one transaction. 409 `details.code: stale` when routes or orders changed since the run (it is then marked `stale`) |
| POST | `/optimizations/:id/discard` | |

What is planned: every unassigned order and every route of that day that
has not started, across active drivers with an active vehicle. Started or
finished routes, and routes of drivers in `keep_driver_ids`, are left as
they are along with their orders. Constraints: pickup before dropoff on
the same vehicle, `weight_kg` against `vehicles.capacity_kg`, and delivery
windows. The objective is straight-line distance plus a charge per minute
a delivery is later than it could be. `summary.proposed.km_for_manual_orders`
compares like with like when the run also places unassigned orders.

The distance matrix comes from `src/distance.js` (`DISTANCE_PROVIDER`,
only `straight_line` today: PostGIS geodesic distance, with times from a
1.35 detour factor at 18 km/h). Phase 5 adds road distances behind the
same interface.

### Live tracking (staff)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/live` | `?date=`. Every route of the day: driver, vehicle, last `location` (with `age_s`), `stops` with `eta` and `eta_minutes`, and `eta_from` (`driver` when based on a position from the last 15 minutes, else `first_stop`) |
| GET | `/live/tracking-quality` | `?date=`. Per driver: points received against expected (one per 30 s), `coverage`, gaps over 90 s, `longest_gap_s`, gap minutes in total and while the app was hidden, points sent late from the phone's queue |
| GET | `/sms` | `?limit=`. The SMS outbox: every message sent or logged, with `provider` (`log` or `termii`) and `status` (`logged`, `sent`, `failed`) |
| POST | `/orders/:id/send-tracking` | Texts the customer their tracking link now |

`GET /orders/:id` also returns `tracking_url` and the order's `sms`.

WebSocket `/ws?token=<staff JWT>` (through the web app: `/api/ws`). Events,
sent after the change has been committed:

- `location`: `driver_id, route_id, location, recorded_at, eta` (fresh ETAs for that route)
- `stop`: `route_id, stop_id, order_id, action, route_status`
- `route`: `route_id` or `route_date` (planned, edited, deleted, or an optimized plan accepted)
- `orders`: an order was created, edited or cancelled

The socket closes with code 4001 when the token expires.

### Driver locations (driver)

| Method | Path | Body |
| --- | --- | --- |
| POST | /driver/locations | `points: [{ lat, lng, recorded_at, accuracy_m?, speed_mps?, heading_deg?, app_visible? }]`, up to 500. Points older than 48 hours or in the future are ignored; a repeated (driver, `recorded_at`) is a no-op. Replies `{ accepted }` |

### Public (no login)

| Method | Path | Notes |
| --- | --- | --- |
| GET | /public/track/:token | The customer's view of one order: first name, status, dropoff address, window, ETA, timeline, the driver's first name and vehicle, and the driver's position only while on the way to this customer and under 10 minutes old. 30 requests a minute per client and link |

### Customer SMS

Sent automatically once per order when the driver starts the trip to the
dropoff (`en_route`) and when it is delivered (`delivered`), plus by hand.
`sms` in `GET /settings` and `PUT /settings`: `provider` (`log` or
`termii`), `base_url` (from the Termii dashboard), `api_key` (write-only,
stored encrypted, a masked hint comes back), `sender_id`, `channel` (`dnd`
for transactional texts, or `generic`), `public_app_url` (the address in
tracking links) and `company_name`. `POST /settings/sms/test { to }` sends
one test message. Termii receives `{ api_key, to: "234...", from, sms,
type: "plain", channel }` at `{base_url}/api/sms/send`.

### Settings

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/settings` | staff | `{ google_maps: {...}, ai: {...} }`, see below |
| PUT | `/settings` | admin | Body `{ google_maps?: { api_key?, map_id? }, ai?: { api_key?, model? } }`. Omitted fields are kept, `""` clears one |
| POST | `/settings/ai/check` | admin | Body `{ api_key? }`. Checks the typed key, or the saved one, with Anthropic and returns `{ ok, models: [{ id, display_name, max_input_tokens, max_tokens }] }`. Saves nothing, uses no tokens |

`google_maps` is `{ api_key, map_id, updated_at, updated_by }`. The Maps
key is a browser key, sent to every staff browser so the dashboard can draw
maps. Its protection is the referrer and API restriction in Google Cloud,
which is why dispatchers can read it.

`ai` never contains the Anthropic key:

- `api_key_set`, `api_key_hint` (masked, `sk-ant-…AbCd`)
- `key_source`: `settings`, `env` (`ANTHROPIC_API_KEY`) or `none`
- `key_unreadable`: a key is saved but cannot be decrypted, usually
  because `SETTINGS_ENCRYPTION_KEY` changed
- `model` and `model_source` (`settings`, `env` from `LLM_MODEL`, `none`)
- `can_save_secrets`: false when `SETTINGS_ENCRYPTION_KEY` is missing;
  saving a key then returns 409
- `updated_at`, `updated_by`

Anthropic keys must match `sk-ant-…`, model IDs `claude-…`. A key Anthropic
rejects comes back as 400 with `details.code` `invalid_key`; other codes are
`permission`, `rate_limited` (429), `upstream` and `network` (502), and 503
when service-python is not reachable.
