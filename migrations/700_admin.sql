-- kullanıcı ek alanları, sözlükler, KVKK metinleri ve talepleri

ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar(16);
-- Kişisel tercihler (bildirimler vb.)
ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Sözlükler: ırk, renk, sahip etiketi, iptal nedeni
CREATE TABLE IF NOT EXISTS dictionaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(20) NOT NULL,             -- breed | color | owner_tag | cancel_reason
  species varchar(20),                   -- yalnızca breed için (cat | dog | ...), diğerlerinde null
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

-- KVKK metinleri, sürümlü: her değişiklik yeni satır
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
('notice', 1, E'ORNEK SABLON - kullanmadan once hukuki danismanlik alin.\n\nKISISEL VERILERIN ISLENMESINE ILISKIN AYDINLATMA METNI\n\n{klinik_ad} olarak, 6698 sayili Kisisel Verilerin Korunmasi Kanunu kapsaminda veri sorumlusu sifatiyla; adiniz, soyadiniz, T.C. kimlik numaraniz, iletisim bilgileriniz ve hayvaniniza ait kayitlar; veteriner hekimlik hizmetinin sunulmasi, mikrocip ve evcil hayvan kayit yukumluluklerinin yerine getirilmesi, randevu ve asi hatirlatmalarinin yapilmasi amaclariyla islenmektedir.\n\nVerileriniz, yasal yukumluluklerin yerine getirilmesi amaciyla yetkili kamu kurumlariyla (or. evcil hayvan kayit sistemi) paylasilabilir. Kanun''un 11. maddesindeki haklariniz icin klinigimize yazili olarak basvurabilirsiniz.'),
('consent', 1, E'ORNEK SABLON - kullanmadan once hukuki danismanlik alin.\n\nACIK RIZA METNI\n\nAydinlatma metnini okudum. Kisisel verilerimin aydinlatma metninde belirtilen amaclar disinda, acik rizami gerektiren islemler icin islenmesine onay veriyorum.'),
('marketing', 1, E'ORNEK SABLON - kullanmadan once hukuki danismanlik alin.\n\nTICARi ELEKTRONIK ILETI IZNI\n\n{klinik_ad} tarafindan kampanya, duyuru ve bilgilendirme amacli SMS ve e-posta gonderilmesine izin veriyorum. Bu izni diledigim zaman geri alabilirim.')
ON CONFLICT DO NOTHING;

-- KVKK talepleri
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
