-- Settings an admin changes from the dashboard instead of .env, for example
-- the Google Maps browser key. One row per setting.
CREATE TABLE app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
