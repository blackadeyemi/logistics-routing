-- Phase 3: what the optimizer needs to know about an order, and a record of
-- every optimization so a proposed plan can be reviewed and then accepted.

-- Parcel weight for vehicle capacity (vehicles.capacity_kg). Orders entered
-- before this default to 1 kg, a typical small parcel.
ALTER TABLE orders ADD COLUMN weight_kg NUMERIC(8, 2) NOT NULL DEFAULT 1 CHECK (weight_kg > 0);

-- Optional delivery window, Lagos time on the route's day. Either end may
-- be open: "only home after 4pm" is dropoff_after 16:00.
ALTER TABLE orders ADD COLUMN dropoff_after TIME;
ALTER TABLE orders ADD COLUMN dropoff_before TIME;
ALTER TABLE orders ADD CONSTRAINT orders_window_order
    CHECK (dropoff_after IS NULL OR dropoff_before IS NULL OR dropoff_after < dropoff_before);

-- One optimizer run for a day: the manual plan it was compared with, the
-- proposed routes, and whether the dispatcher accepted it.
CREATE TABLE optimization_runs (
    id                 BIGSERIAL PRIMARY KEY,
    route_date         DATE NOT NULL,
    created_by         INT REFERENCES users(id) ON DELETE SET NULL,
    distance_provider  VARCHAR(30) NOT NULL,
    manual             JSONB NOT NULL,
    proposed           JSONB NOT NULL,
    unassigned         JSONB NOT NULL DEFAULT '[]',
    manual_km          NUMERIC(10, 2) NOT NULL,
    proposed_km        NUMERIC(10, 2) NOT NULL,
    solve_ms           INT NOT NULL,
    status             VARCHAR(20) NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed', 'accepted', 'discarded', 'stale')),
    decided_by         INT REFERENCES users(id) ON DELETE SET NULL,
    decided_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_optimization_runs_date ON optimization_runs (route_date, created_at DESC);
