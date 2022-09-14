-- Modül B: sahipler — KVKK rıza geçmişi ve ek sahip alanları

-- Rıza geçmişi: her değişiklik yeni satır (kim, ne zaman, hangi metin sürümü, hangi kanal)
CREATE TABLE IF NOT EXISTS consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  type varchar(20) NOT NULL,              -- kvkk_notice | reminder | marketing
  granted boolean NOT NULL,
  text_version varchar(30),
  channel varchar(20),                    -- printed | verbal | sms | system
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS consents_owner_idx ON consents (owner_id, at DESC);

ALTER TABLE owners ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE owners ADD COLUMN IF NOT EXISTS is_foreign boolean NOT NULL DEFAULT false;
-- Yabancı uyruklu sahibin pasaport no'su (şifreli) ve son 4 hanesi
ALTER TABLE owners ADD COLUMN IF NOT EXISTS foreign_doc_enc text;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS foreign_doc_last4 varchar(4);
ALTER TABLE owners ADD COLUMN IF NOT EXISTS kvkk_notice_method varchar(20);
ALTER TABLE owners ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id);
-- Birleştirmede silinen kaydın hangi kayda taşındığı
ALTER TABLE owners ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES owners(id);

CREATE INDEX IF NOT EXISTS owners_tags_idx ON owners USING gin (tags);
