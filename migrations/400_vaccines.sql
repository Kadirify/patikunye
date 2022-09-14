-- Modül D — Aşılar: ürünler, protokoller, uygulamalar, aşı planı (vadeler)

CREATE TABLE IF NOT EXISTS vaccine_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  manufacturer text,
  kind varchar(20) NOT NULL CHECK (kind IN ('rabies','combo','felv','kc','lyme','internal_parasite','external_parasite','other')),
  species text[] NOT NULL DEFAULT '{}'::text[],   -- boş = tüm türler
  immunity_days integer CHECK (immunity_days IS NULL OR immunity_days > 0),
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vaccine_products_kind_idx ON vaccine_products (kind) WHERE active;

-- steps: [{ "label": "1. doz", "minAgeWeeks": 8 }, { "label": "2. doz", "afterPrevWeeks": 3 }, { "label": "Yıllık rapel", "afterPrevWeeks": 52, "thenEveryDays": 365 }]
-- Son adımda thenEveryDays varsa o adım süresiz tekrarlanır (rapel).
CREATE TABLE IF NOT EXISTS vaccine_protocols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  species varchar(20) NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('rabies','combo','felv','kc','lyme','internal_parasite','external_parasite','other')),
  name text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vaccine_protocols_species_idx ON vaccine_protocols (species, kind) WHERE active;

CREATE TABLE IF NOT EXISTS vaccinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id uuid NOT NULL REFERENCES animals(id),
  product_id uuid REFERENCES vaccine_products(id),
  product_name text,                       -- dış kayıtta ya da ürün listede yoksa serbest metin
  kind varchar(20) NOT NULL,
  lot_no text,
  expiry_date date,
  given_at date NOT NULL,
  given_by uuid REFERENCES users(id),
  dose_label text,
  protocol_id uuid REFERENCES vaccine_protocols(id),
  visit_id uuid,                           -- muayene modülü (C); bilerek FK yok
  passport_recorded boolean NOT NULL DEFAULT false,
  side_effects text,
  external boolean NOT NULL DEFAULT false, -- başka klinikte yapıldı
  external_clinic text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  delete_reason text
);
CREATE INDEX IF NOT EXISTS vaccinations_animal_idx ON vaccinations (animal_id, kind, given_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS vaccination_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id uuid NOT NULL REFERENCES animals(id),
  kind varchar(20) NOT NULL,
  dose_label text,
  protocol_id uuid REFERENCES vaccine_protocols(id),
  due_date date NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','postponed','cancelled','external')),
  vaccination_id uuid REFERENCES vaccinations(id),
  reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vaccination_plans_open_idx ON vaccination_plans (due_date) WHERE status IN ('planned','postponed');
CREATE INDEX IF NOT EXISTS vaccination_plans_animal_idx ON vaccination_plans (animal_id, kind);

-- Hayvana özel protokol seçimi ("Protokol değiştir"). Kayıt yoksa tür + aşı türü için ilk etkin protokol kullanılır.
CREATE TABLE IF NOT EXISTS animal_vaccine_protocols (
  animal_id uuid NOT NULL REFERENCES animals(id),
  kind varchar(20) NOT NULL,
  protocol_id uuid NOT NULL REFERENCES vaccine_protocols(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (animal_id, kind)
);

-- ⚠️ ÖRNEK ürünler; hekim onayıyla düzenlenecek. Marka adları yalnızca örnektir, bağışıklık süreleri doğrulanacak.
INSERT INTO vaccine_products (name, manufacturer, kind, species, immunity_days, notes)
SELECT * FROM (VALUES
  ('Rabisin', 'Boehringer Ingelheim', 'rabies', ARRAY['cat','dog','ferret'], 365, '⚠️ örnek'),
  ('Nobivac Rabies', 'MSD', 'rabies', ARRAY['cat','dog','ferret'], 365, '⚠️ örnek'),
  ('Nobivac DHPPi+L', 'MSD', 'combo', ARRAY['dog'], 365, '⚠️ örnek'),
  ('Vanguard Plus 5/L4', 'Zoetis', 'combo', ARRAY['dog'], 365, '⚠️ örnek'),
  ('Purevax RCP', 'Boehringer Ingelheim', 'combo', ARRAY['cat'], 365, '⚠️ örnek'),
  ('Purevax FeLV', 'Boehringer Ingelheim', 'felv', ARRAY['cat'], 365, '⚠️ örnek'),
  ('Nobivac KC', 'MSD', 'kc', ARRAY['dog'], 365, '⚠️ örnek'),
  ('Merilym 3', 'Boehringer Ingelheim', 'lyme', ARRAY['dog'], 365, '⚠️ örnek'),
  ('Milbemax', 'Elanco', 'internal_parasite', ARRAY['cat','dog'], 90, '⚠️ örnek'),
  ('Bravecto', 'MSD', 'external_parasite', ARRAY['cat','dog'], 84, '⚠️ örnek')
) AS v(name, manufacturer, kind, species, immunity_days, notes)
WHERE NOT EXISTS (SELECT 1 FROM vaccine_products);

-- ⚠️ ÖRNEK protokoller; hekim onayıyla düzenlenecek (yaş ve aralıklar doğrulanacak).
INSERT INTO vaccine_protocols (species, kind, name, steps)
SELECT * FROM (VALUES
  ('dog', 'combo', 'Köpek karma (DHPPi+L)', '[{"label":"1. doz","minAgeWeeks":6},{"label":"2. doz","afterPrevWeeks":3},{"label":"3. doz","afterPrevWeeks":3},{"label":"Yıllık rapel","afterPrevWeeks":52,"thenEveryDays":365}]'::jsonb),
  ('dog', 'rabies', 'Köpek kuduz', '[{"label":"1. doz","minAgeWeeks":12},{"label":"Yıllık rapel","afterPrevWeeks":52,"thenEveryDays":365}]'::jsonb),
  ('dog', 'kc', 'Köpek bronşin (KC)', '[{"label":"1. doz","minAgeWeeks":8},{"label":"Yıllık rapel","afterPrevWeeks":52,"thenEveryDays":365}]'::jsonb),
  ('dog', 'internal_parasite', 'Köpek iç parazit', '[{"label":"Uygulama","minAgeWeeks":2,"thenEveryDays":90}]'::jsonb),
  ('dog', 'external_parasite', 'Köpek dış parazit', '[{"label":"Uygulama","minAgeWeeks":8,"thenEveryDays":30}]'::jsonb),
  ('cat', 'combo', 'Kedi karma (FVRCP)', '[{"label":"1. doz","minAgeWeeks":8},{"label":"2. doz","afterPrevWeeks":3},{"label":"3. doz","afterPrevWeeks":4},{"label":"Yıllık rapel","afterPrevWeeks":52,"thenEveryDays":365}]'::jsonb),
  ('cat', 'rabies', 'Kedi kuduz', '[{"label":"1. doz","minAgeWeeks":12},{"label":"Yıllık rapel","afterPrevWeeks":52,"thenEveryDays":365}]'::jsonb),
  ('cat', 'felv', 'Kedi lösemi (FeLV)', '[{"label":"1. doz","minAgeWeeks":8},{"label":"2. doz","afterPrevWeeks":3},{"label":"Yıllık rapel","afterPrevWeeks":52,"thenEveryDays":365}]'::jsonb),
  ('cat', 'internal_parasite', 'Kedi iç parazit', '[{"label":"Uygulama","minAgeWeeks":2,"thenEveryDays":90}]'::jsonb),
  ('cat', 'external_parasite', 'Kedi dış parazit', '[{"label":"Uygulama","minAgeWeeks":8,"thenEveryDays":30}]'::jsonb)
) AS v(species, kind, name, steps)
WHERE NOT EXISTS (SELECT 1 FROM vaccine_protocols);
