-- Phase 4: live tracking, customer tracking links and SMS.

-- Positions from the driver app. recorded_at is when the phone took the
-- fix (points sent late from the offline queue keep it); received_at is
-- when the API got it. app_visible records whether the app was on screen,
-- which is how the cost of background throttling is measured.
CREATE TABLE driver_locations (
    id           BIGSERIAL PRIMARY KEY,
    driver_id    INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    route_id     BIGINT REFERENCES routes(id) ON DELETE SET NULL,
    location     GEOGRAPHY(POINT, 4326) NOT NULL,
    accuracy_m   REAL,
    speed_mps    REAL,
    heading_deg  REAL,
    app_visible  BOOLEAN,
    recorded_at  TIMESTAMPTZ NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (driver_id, recorded_at)
);
CREATE INDEX idx_driver_locations_recent ON driver_locations (driver_id, recorded_at DESC);

-- Unguessable token for the public tracking page, one per order: 32 hex
-- characters from a random UUID (122 random bits).
ALTER TABLE orders ADD COLUMN tracking_token VARCHAR(32) NOT NULL
    DEFAULT replace(gen_random_uuid()::text, '-', '');
ALTER TABLE orders ADD CONSTRAINT uq_orders_tracking_token UNIQUE (tracking_token);

-- Every SMS the system sends or would send. With no SMS provider set up,
-- messages are kept here with status 'logged' so the dashboard shows what
-- customers would receive.
CREATE TABLE sms_messages (
    id                  BIGSERIAL PRIMARY KEY,
    order_id            BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    to_phone            VARCHAR(30) NOT NULL,
    body                TEXT NOT NULL,
    reason              VARCHAR(30) NOT NULL,
    provider            VARCHAR(30) NOT NULL,
    status              VARCHAR(20) NOT NULL CHECK (status IN ('logged', 'sent', 'failed')),
    provider_message_id TEXT,
    error               TEXT,
    created_by          INT REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sms_messages_created ON sms_messages (created_at DESC);
-- Automatic messages go out once per order; a dispatcher can resend by hand.
CREATE UNIQUE INDEX uq_sms_automatic ON sms_messages (order_id, reason) WHERE reason IN ('en_route', 'delivered');
