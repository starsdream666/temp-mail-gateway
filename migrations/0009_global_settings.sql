CREATE TABLE global_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  admin_password_hash TEXT,
  health_check_enabled INTEGER,
  health_check_interval_ms INTEGER,
  mailboxes_per_key_per_hour INTEGER,
  max_concurrent_requests_per_key INTEGER
);
ALTER TABLE api_keys ADD COLUMN max_concurrent_requests INTEGER;
