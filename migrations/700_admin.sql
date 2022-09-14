-- Modül F: kullanıcı ek alanları, sözlükler, KVKK metinleri ve talepleri

ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar(16);
-- Kişisel tercihler (bildirimler vb.)
ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Sözlükler (S-104): ırk, renk, sahip etiketi, iptal nedeni
CREATE TABLE IF NOT EXISTS dictionaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(20) NOT NULL,             -- breed | color | owner_tag | cancel_reason
  species varchar(20),                   -- yalnızca breed için (cat | dog | …), diğerlerinde null
  value text NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dictionaries_uq ON dictionaries (kind, coalesce(species, ''), lower(value));
CREATE INDEX IF NOT EXISTS dictionaries_kind_idx ON dictionaries (kind, species, sort);

INSERT INTO dictionaries (kind, species, value, sort)
SELECT 'breed', 'cat', v, n FROM unnest(ARRAY[
  'Tekir', 'Melez', 'Van Kedisi', 'Ankara Kedisi', 'British Shorthair', 'Scottish Fold', 'İran (Persian)',
  'Siyam', 'Maine Coon', 'Ragdoll', 'Bengal', 'Sfenks', 'Rus Mavisi', 'Exotic Shorthair', 'Norveç Orman Kedisi',
  'Habeş (Abyssinian)', 'British Longhair', 'Diğer'
]) WITH ORDINALITY AS t(v, n)
ON CONFLICT DO NOTHING;

INSERT INTO dictionaries (kind, species, value, sort)
SELECT 'breed', 'dog', v, n FROM unnest(ARRAY[
  'Melez', 'Kangal', 'Akbaş', 'Kars Çoban Köpeği', 'Golden Retriever', 'Labrador Retriever', 'Alman Çoban Köpeği',
  'Sibirya Kurdu (Husky)', 'Pomeranian', 'Maltese Terrier', 'Yorkshire Terrier', 'Pug', 'Fransız Bulldog',
  'İngiliz Bulldog', 'Beagle', 'Cocker Spaniel', 'Poodle', 'Chihuahua', 'Shih Tzu', 'Rottweiler', 'Doberman',
  'Border Collie', 'Jack Russell Terrier', 'Samoyed', 'Cane Corso', 'Diğer'
]) WITH ORDINALITY AS t(v, n)
ON CONFLICT DO NOTHING;

INSERT INTO dictionaries (kind, species, value, sort)
SELECT 'color', NULL, v, n FROM unnest(ARRAY[
  'Siyah', 'Beyaz', 'Gri', 'Sarı', 'Turuncu', 'Kahverengi', 'Krem', 'Siyah-beyaz', 'Gri-beyaz', 'Sarı-beyaz',
  'Tekir (çizgili)', 'Üç renkli (calico)', 'Kaplumbağa (tortie)', 'Benekli', 'Alaca', 'Bej', 'Mavi (füme)', 'Diğer'
]) WITH ORDINALITY AS t(v, n)
ON CONFLICT DO NOTHING;

INSERT INTO dictionaries (kind, species, value, sort)
SELECT 'owner_tag', NULL, v, n FROM unnest(ARRAY['VIP', 'Barınak', 'Belediye', 'Gönüllü', 'Borçlu', 'Dikkat'])
WITH ORDINALITY AS t(v, n)
ON CONFLICT DO NOTHING;

INSERT INTO dictionaries (kind, species, value, sort)
SELECT 'cancel_reason', NULL, v, n FROM unnest(ARRAY['Sahip iptal etti', 'Gelmedi', 'Hekim müsait değil', 'Hayvan iyileşti', 'Başka kliniğe gitti', 'Diğer'])
WITH ORDINALITY AS t(v, n)
ON CONFLICT DO NOTHING;

-- KVKK metinleri (S-114), sürümlü: her değişiklik yeni satır
CREATE TABLE IF NOT EXISTS kvkk_texts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(20) NOT NULL,             -- notice | consent | marketing
  version integer NOT NULL,
  body text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE (kind, version)
);

INSERT INTO kvkk_texts (kind, version, body) VALUES
('notice', 1, E'⚠️ HUKUKÇU ONAYI GEREKLİDİR — bu metin örnek şablondur, kullanmadan önce bir hukukçuya inceletin.\n\nKİŞİSEL VERİLERİN İŞLENMESİNE İLİŞKİN AYDINLATMA METNİ\n\n{klinik_ad} olarak, 6698 sayılı Kişisel Verilerin Korunması Kanunu kapsamında veri sorumlusu sıfatıyla; adınız, soyadınız, T.C. kimlik numaranız, iletişim bilgileriniz ve hayvanınıza ait kayıtlar; veteriner hekimlik hizmetinin sunulması, mikroçip ve evcil hayvan kayıt yükümlülüklerinin yerine getirilmesi, randevu ve aşı hatırlatmalarının yapılması amaçlarıyla işlenmektedir.\n\nVerileriniz, yasal yükümlülüklerin yerine getirilmesi amacıyla yetkili kamu kurumlarıyla (ör. evcil hayvan kayıt sistemi) paylaşılabilir. Kanun''un 11. maddesindeki haklarınız için kliniğimize yazılı olarak başvurabilirsiniz.'),
('consent', 1, E'⚠️ HUKUKÇU ONAYI GEREKLİDİR — bu metin örnek şablondur.\n\nAÇIK RIZA METNİ\n\nAydınlatma metnini okudum. Kişisel verilerimin aydınlatma metninde belirtilen amaçlar dışında, açık rızamı gerektiren işlemler için işlenmesine onay veriyorum.'),
('marketing', 1, E'⚠️ HUKUKÇU ONAYI GEREKLİDİR — bu metin örnek şablondur.\n\nTİCARİ ELEKTRONİK İLETİ İZNİ\n\n{klinik_ad} tarafından kampanya, duyuru ve bilgilendirme amaçlı SMS ve e-posta gönderilmesine izin veriyorum. Bu izni dilediğim zaman geri alabilirim.')
ON CONFLICT DO NOTHING;

-- KVKK talepleri (S-95)
CREATE TABLE IF NOT EXISTS kvkk_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  type varchar(12) NOT NULL,             -- info | copy | correct | erase | objection
  received_at date NOT NULL,
  channel varchar(12) NOT NULL,          -- written | email | kep | in_person
  status varchar(10) NOT NULL DEFAULT 'open', -- open | done | rejected
  due_date date NOT NULL,
  note text,
  response_note text,
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kvkk_requests_status_idx ON kvkk_requests (status, due_date);
CREATE INDEX IF NOT EXISTS kvkk_requests_owner_idx ON kvkk_requests (owner_id);

-- Anonimleştirilen sahibin işareti
ALTER TABLE owners ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;
