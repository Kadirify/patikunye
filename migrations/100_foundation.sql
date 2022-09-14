-- Ortak: şifreli ek dosyalar (muayene ekleri, imzalı formlar, PETVET belgeleri, sahip belgeleri)
CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type varchar(30) NOT NULL,      -- animal | owner | visit | petvet_task | kvkk_request
  owner_id uuid NOT NULL,
  file_name text NOT NULL,
  mime varchar(100) NOT NULL,
  size integer NOT NULL,
  storage_key text NOT NULL,            -- filesDir altındaki dosya adı
  sha256 varchar(64) NOT NULL,
  note text,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS attachments_owner_idx ON attachments (owner_type, owner_id);

-- Kilo geçmişi (muayeneden ya da elle). Muayene modülü yazar, hayvan ekranı gösterir.
CREATE TABLE IF NOT EXISTS animal_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id uuid NOT NULL REFERENCES animals(id),
  kg numeric(6,2) NOT NULL CHECK (kg > 0 AND kg < 200),
  measured_at timestamptz NOT NULL DEFAULT now(),
  source varchar(10) NOT NULL DEFAULT 'manual', -- manual | visit
  visit_id uuid,
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS animal_weights_animal_idx ON animal_weights (animal_id, measured_at DESC);

-- PETVET görevine kanıt belgesi
ALTER TABLE petvet_tasks ADD COLUMN IF NOT EXISTS evidence_attachment_id uuid REFERENCES attachments(id);
