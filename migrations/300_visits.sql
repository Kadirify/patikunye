-- Modül C: muayene (SOAP) ve tedavi kayıtları (SAYFALAR S-40, S-41, S-42, §15.5)
-- İmzalı muayene değiştirilemez; "Ek/düzeltme" aynı zincirde yeni versiyon (yeni satır) oluşturur.
--   root_id       = zincirin ilk versiyonunun id'si (v1 için kendi id'si)
--   supersedes_id = bir önceki versiyon
--   version       = 1, 2, 3 … (muayene versiyonu)
--   rev           = iyimser kilit sayacı (taslak her kaydedildiğinde artar)
CREATE TABLE IF NOT EXISTS visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id uuid NOT NULL REFERENCES animals(id),
  vet_id uuid REFERENCES users(id),                 -- taslakta boş olabilir; imzada zorunlu
  visit_at timestamptz NOT NULL DEFAULT now(),
  type varchar(12) NOT NULL DEFAULT 'exam'
    CHECK (type IN ('exam', 'control', 'emergency', 'vaccine', 'surgery', 'home')),
  appointment_id uuid,                              -- randevu modülü ayrı; yabancı anahtar yok
  subjective text,
  findings jsonb NOT NULL DEFAULT '{"vitals": {}, "systems": {}}',
  assessment text,
  diagnoses text[] NOT NULL DEFAULT '{}',
  differential text[] NOT NULL DEFAULT '{}',
  plan_text text,
  tests text,                                       -- istenen tetkikler
  owner_advice text,                                -- sahibe öneriler (yazdırılır)
  internal_note text,                               -- iç not (sahip sürümünde basılmaz)
  control_date date,
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
  signed_at timestamptz,
  signed_by uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  supersedes_id uuid REFERENCES visits(id),
  root_id uuid,
  amend_reason text,
  rev integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  deleted_at timestamptz,                           -- yalnızca taslak silinebilir
  CHECK (status = 'draft' OR (signed_at IS NOT NULL AND signed_by IS NOT NULL AND vet_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS visits_animal_idx ON visits (animal_id, visit_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visits_vet_idx ON visits (vet_id, visit_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visits_at_idx ON visits (visit_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visits_draft_idx ON visits (created_at) WHERE status = 'draft' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visits_root_idx ON visits (root_id);
CREATE INDEX IF NOT EXISTS visits_appointment_idx ON visits (appointment_id) WHERE appointment_id IS NOT NULL;
-- Bir versiyonun en fazla bir (silinmemiş) halefi olabilir
CREATE UNIQUE INDEX IF NOT EXISTS visits_supersedes_uq ON visits (supersedes_id) WHERE supersedes_id IS NOT NULL AND deleted_at IS NULL;

-- İmzalı muayene veritabanı düzeyinde de korunur: içerik alanları değiştirilemez
CREATE OR REPLACE FUNCTION visits_signed_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'signed' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.subjective IS DISTINCT FROM OLD.subjective
    OR NEW.findings IS DISTINCT FROM OLD.findings
    OR NEW.assessment IS DISTINCT FROM OLD.assessment
    OR NEW.diagnoses IS DISTINCT FROM OLD.diagnoses
    OR NEW.differential IS DISTINCT FROM OLD.differential
    OR NEW.plan_text IS DISTINCT FROM OLD.plan_text
    OR NEW.tests IS DISTINCT FROM OLD.tests
    OR NEW.owner_advice IS DISTINCT FROM OLD.owner_advice
    OR NEW.internal_note IS DISTINCT FROM OLD.internal_note
    OR NEW.control_date IS DISTINCT FROM OLD.control_date
    OR NEW.visit_at IS DISTINCT FROM OLD.visit_at
    OR NEW.vet_id IS DISTINCT FROM OLD.vet_id
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
    OR NEW.signed_by IS DISTINCT FROM OLD.signed_by
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  ) THEN
    RAISE EXCEPTION 'İmzalı muayene değiştirilemez' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS visits_signed_guard_trg ON visits;
CREATE TRIGGER visits_signed_guard_trg BEFORE UPDATE ON visits FOR EACH ROW EXECUTE FUNCTION visits_signed_guard();

-- Tedavi / ilaç satırları (S-42). Muayeneye bağlı; taslakta her kayıtta yeniden yazılır.
CREATE TABLE IF NOT EXISTS treatments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES visits(id),
  animal_id uuid NOT NULL REFERENCES animals(id),
  sort integer NOT NULL DEFAULT 0,
  drug text NOT NULL,
  active_ingredient text,
  dose numeric(12,3),
  dose_unit varchar(12),
  per_kg boolean NOT NULL DEFAULT false,
  total_dose numeric(14,3),                         -- mg/kg dozda kiloya göre hesaplanan toplam
  route varchar(20),
  frequency text,
  duration text,
  duration_days integer,                            -- süren tedavi hesabı için
  kind varchar(12) NOT NULL DEFAULT 'administered' CHECK (kind IN ('administered', 'prescribed')),
  e_recete_no varchar(40),                          -- ⚠️ e-reçete Bakanlık sisteminde yazılır; burada yalnızca numara
  note text,
  allergy_ack boolean NOT NULL DEFAULT false,       -- alerji uyarısına rağmen hekim onayladı
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS treatments_visit_idx ON treatments (visit_id, sort);
CREATE INDEX IF NOT EXISTS treatments_animal_idx ON treatments (animal_id);

-- Sık kullanılan tanılar (tanı seçici önerileri)
CREATE TABLE IF NOT EXISTS diagnosis_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS diagnosis_terms_name_uq ON diagnosis_terms (lower(name));

-- "/" ile eklenen hazır cümleler
CREATE TABLE IF NOT EXISTS visit_phrases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcut varchar(30) NOT NULL,
  text text NOT NULL,
  field varchar(12) NOT NULL DEFAULT 'any' CHECK (field IN ('subjective', 'assessment', 'plan', 'advice', 'any')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS visit_phrases_shortcut_uq ON visit_phrases (lower(shortcut));

-- ⚠️ Başlangıç tanı listesi örnek amaçlıdır; pilot hekim onayıyla düzenlenecek (Ayarlar'dan yönetim ileride).
INSERT INTO diagnosis_terms (name, category, sort) VALUES
  ('Akut gastroenterit', 'Sindirim', 10),
  ('Gastrit', 'Sindirim', 20),
  ('Yabancı cisim (GİS)', 'Sindirim', 30),
  ('Pankreatit', 'Sindirim', 40),
  ('Kabızlık', 'Sindirim', 50),
  ('Diş taşı / periodontal hastalık', 'Ağız-diş', 10),
  ('Stomatit', 'Ağız-diş', 20),
  ('Otitis externa', 'Kulak', 10),
  ('Kulak uyuzu (Otodectes)', 'Kulak', 20),
  ('Konjonktivit', 'Göz', 10),
  ('Kornea ülseri', 'Göz', 20),
  ('Atopik dermatit', 'Deri', 10),
  ('Pire alerjisi dermatiti', 'Deri', 20),
  ('Dermatofitoz', 'Deri', 30),
  ('Piyoderma', 'Deri', 40),
  ('Apse', 'Deri', 50),
  ('Üst solunum yolu enfeksiyonu', 'Solunum', 10),
  ('Kennel cough (enfeksiyöz trakeobronşit)', 'Solunum', 20),
  ('Pnömoni', 'Solunum', 30),
  ('Feline idiyopatik sistit (FİS)', 'Ürogenital', 10),
  ('Üriner obstrüksiyon', 'Ürogenital', 20),
  ('İdrar yolu enfeksiyonu', 'Ürogenital', 30),
  ('Pyometra', 'Ürogenital', 40),
  ('Kronik böbrek hastalığı', 'Ürogenital', 50),
  ('Diabetes mellitus', 'Endokrin', 10),
  ('Hipertiroidi', 'Endokrin', 20),
  ('Obezite', 'Genel', 10),
  ('İç parazitoz', 'Parazit', 10),
  ('Dış parazitoz (pire/kene)', 'Parazit', 20),
  ('Topallık', 'Kas-iskelet', 10),
  ('Kırık', 'Kas-iskelet', 20),
  ('Ön çapraz bağ yırtığı', 'Kas-iskelet', 30),
  ('Kalça displazisi', 'Kas-iskelet', 40),
  ('Dirsek displazisi', 'Kas-iskelet', 50),
  ('Yumuşak doku travması', 'Travma', 10),
  ('Isırık yarası', 'Travma', 20),
  ('Kalp yetmezliği', 'Dolaşım', 10),
  ('Epilepsi / nöbet', 'Sinir', 10),
  ('Parvoviral enterit', 'Enfeksiyon', 10),
  ('Panleukopeni', 'Enfeksiyon', 20),
  ('Kedi gribi (FHV/FCV)', 'Enfeksiyon', 30),
  ('Gıda alerjisi', 'Alerji', 10),
  ('Sağlıklı — rutin kontrol', 'Genel', 1)
ON CONFLICT DO NOTHING;

-- ⚠️ Örnek hazır cümleler; klinik kendi cümlelerini ekleyecek.
INSERT INTO visit_phrases (shortcut, text, field) VALUES
  ('kusma', 'Son 2 gündür kusma, iştahsızlık. Su içiyor. İshal yok.', 'subjective'),
  ('ishal', 'Son 2 gündür ishal; dışkı sulu, kan yok. İştah azalmış.', 'subjective'),
  ('kasinti', 'Bir haftadır kaşıntı, özellikle geceleri artıyor. Tüy dökülmesi var.', 'subjective'),
  ('topallik', 'Ani başlayan topallık; travma öyküsü belirsiz.', 'subjective'),
  ('kontrol', 'Kontrol muayenesi; önceki tedaviye yanıt iyi, şikayet yok.', 'subjective'),
  ('normal', 'Genel durum iyi, bilinç açık. Muayenede belirgin patolojik bulgu saptanmadı.', 'assessment'),
  ('perhiz', '12 saat yiyecek verilmeyecek, su serbest. Ardından az az ve sık hafif diyet.', 'advice'),
  ('yaka', 'Yara bölgesini yalamaması için koruyucu yaka (elizabet tasması) takılı kalacak.', 'advice'),
  ('ilac', 'İlaçları önerilen doz ve sürede eksiksiz kullanınız; yan etki görürseniz kliniği arayınız.', 'advice')
ON CONFLICT DO NOTHING;
