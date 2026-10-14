-- Yerel ağ: ana bilgisayara bağlanan istemci cihazlar
CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE,   -- sha256(cihaz anahtarı)
  paired_at timestamptz NOT NULL DEFAULT now(),
  paired_by uuid REFERENCES users(id),
  last_seen_at timestamptz,
  last_ip text,
  app_version text,
  revoked_at timestamptz
);
