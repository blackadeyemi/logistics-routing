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
| POST | /orders | `customer_name, customer_phone, pickup_address, pickup_location?, pickup_notes?, dropoff_address, dropoff_location?, dropoff_notes?` |
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
