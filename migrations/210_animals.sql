-- Modül B: hayvanlar — ek klinik alanlar, durum geçmişi, sahiplik geçmişi nedeni

ALTER TABLE animals ADD COLUMN IF NOT EXISTS chronic_diseases text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE animals ADD COLUMN IF NOT EXISTS blood_group varchar(20);
ALTER TABLE animals ADD COLUMN IF NOT EXISTS diet text;
-- Sahiplenme ise barınak / belediye adı
ALTER TABLE animals ADD COLUMN IF NOT EXISTS source_detail text;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id);

-- Devir / sahiplik sonu nedeni
ALTER TABLE animal_owners ADD COLUMN IF NOT EXISTS end_reason text;

-- Durum değişiklikleri (ölüm, kayıp, bulundu, devir)
CREATE TABLE IF NOT EXISTS animal_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id uuid NOT NULL REFERENCES animals(id),
  kind varchar(12) NOT NULL,              -- death | lost | found | transfer
  event_date date NOT NULL,
  from_status varchar(12),
  to_status varchar(12),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id uuid REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS animal_status_events_animal_idx ON animal_status_events (animal_id, at DESC);
