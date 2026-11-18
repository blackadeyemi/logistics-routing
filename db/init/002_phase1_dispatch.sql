-- Phase 1 additions: driver login, one route per driver per day, and an
-- order event timeline that also makes offline driver updates idempotent.

-- Drivers log in to the PWA with their phone number and a short PIN.
ALTER TABLE drivers ADD COLUMN pin_hash VARCHAR(255);

-- A driver has at most one route per day.
ALTER TABLE routes
    ADD CONSTRAINT uq_routes_driver_date UNIQUE (driver_id, route_date);

CREATE INDEX idx_stops_order ON stops (order_id);

-- Timeline of everything that happens to an order. Driver actions carry
-- the time the driver tapped (occurred_at), which can be earlier than
-- created_at when the update was queued offline. client_event_id lets the
-- PWA retry a queued update without recording it twice.
CREATE TABLE order_events (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    stop_id         BIGINT REFERENCES stops(id) ON DELETE SET NULL,
    event_type      VARCHAR(30) NOT NULL
                    CHECK (event_type IN
                        ('created', 'updated', 'assigned', 'unassigned',
                         'arrived', 'picked_up', 'en_route', 'delivered',
                         'skipped', 'cancelled')),
    actor_type      VARCHAR(10) NOT NULL
                    CHECK (actor_type IN ('user', 'driver', 'system')),
    actor_id        BIGINT,
    client_event_id VARCHAR(64) UNIQUE,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_events_order ON order_events (order_id, occurred_at);
