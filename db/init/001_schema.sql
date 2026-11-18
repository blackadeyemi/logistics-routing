-- Phase 1 schema: manual dispatch replacement.
-- PostGIS is enabled now so geography columns are ready before Phase 3
-- optimization work needs them.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Dispatchers and admins who log in to the dashboard.
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(255) NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'dispatcher'
                  CHECK (role IN ('admin', 'dispatcher')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
    id             BIGSERIAL PRIMARY KEY,
    type           VARCHAR(20)  NOT NULL
                   CHECK (type IN ('bike', 'keke', 'van', 'truck')),
    plate_number   VARCHAR(50)  NOT NULL UNIQUE,
    capacity_kg    NUMERIC(10, 2),
    status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'maintenance', 'inactive')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    phone        VARCHAR(30)  NOT NULL UNIQUE,
    email        VARCHAR(255) UNIQUE,
    vehicle_id   BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
    status       VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id                BIGSERIAL PRIMARY KEY,
    customer_name     VARCHAR(255) NOT NULL,
    customer_phone    VARCHAR(30)  NOT NULL,
    pickup_address    TEXT         NOT NULL,
    pickup_location   GEOGRAPHY(POINT, 4326),
    dropoff_address   TEXT         NOT NULL,
    dropoff_location  GEOGRAPHY(POINT, 4326),
    status            VARCHAR(20)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN
                          ('pending', 'assigned', 'picked_up',
                           'en_route', 'delivered', 'cancelled')),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- A route is one driver's set of stops for a given day, assigned by hand
-- in Phase 1. Optimization fills route order in Phase 3.
CREATE TABLE routes (
    id           BIGSERIAL PRIMARY KEY,
    driver_id    BIGINT REFERENCES drivers(id) ON DELETE SET NULL,
    vehicle_id   BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
    route_date   DATE         NOT NULL,
    status       VARCHAR(20)  NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned', 'in_progress', 'completed')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- A stop is a single pickup or dropoff on a route, in sequence.
CREATE TABLE stops (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    route_id        BIGINT REFERENCES routes(id) ON DELETE SET NULL,
    sequence_number INTEGER,
    stop_type       VARCHAR(10) NOT NULL
                    CHECK (stop_type IN ('pickup', 'dropoff')),
    location        GEOGRAPHY(POINT, 4326),
    address         TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN
                        ('pending', 'arrived', 'completed', 'skipped')),
    arrived_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Standard lookups Phase 1 will use constantly.
CREATE INDEX idx_drivers_status       ON drivers (status);
CREATE INDEX idx_orders_status        ON orders (status);
CREATE INDEX idx_routes_driver_date   ON routes (driver_id, route_date);
CREATE INDEX idx_stops_route_sequence ON stops (route_id, sequence_number);

-- Spatial indexes, unused in Phase 1 queries but ready for Phase 3.
CREATE INDEX idx_orders_pickup_geo  ON orders  USING GIST (pickup_location);
CREATE INDEX idx_orders_dropoff_geo ON orders  USING GIST (dropoff_location);
CREATE INDEX idx_stops_geo          ON stops   USING GIST (location);
