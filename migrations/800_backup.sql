-- Modül G: yedekleme (SAYFALAR S-108)
-- Not: Bu tablolara users vb. tablolardan yabancı anahtar VERİLMEZ; geri yüklemede
-- "TRUNCATE … CASCADE" bu tabloları boşaltmasın ve kayıtlar kurulum-yerel kalsın diye.

-- Tek satırlık yedek yapılandırması (yedek parolası)
CREATE TABLE IF NOT EXISTS backup_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- scrypt doğrulayıcısı: scrypt$N$r$p$salt(b64)$hash(b64)
  password_verifier text,
  -- Otomatik yedek için parolanın kendisi, bu kurulumun veri anahtarıyla şifreli (deps.crypto.encrypt)
  password_enc text,
  password_set_at timestamptz,
  password_set_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Yedek geçmişi
CREATE TABLE IF NOT EXISTS backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  reason varchar(20) NOT NULL,            -- daily | manual | pre_update | pre_restore
  file_name text,
  size bigint,
  sha256 varchar(64),                     -- dosyanın tamamının özeti (hedef kopyaları karşılaştırmak için)
  targets jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ path, ok, error?, sameDisk? }]
  rows_total integer,
  files_total integer,
  verified_at timestamptz,
  verify_result text,
  verify_ok boolean,
  error text,
  created_by uuid,
  pruned_at timestamptz                   -- saklama politikasıyla tüm hedeflerden silindi
);
CREATE INDEX IF NOT EXISTS backups_started_idx ON backups (started_at DESC);
