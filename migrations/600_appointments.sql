-- Modül E: Randevu, bekleme salonu, randevu türleri, tatiller

create table if not exists appointment_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color varchar(7) not null default '#8FA9D3',
  default_minutes int not null default 30 check (default_minutes between 5 and 480),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into appointment_types (name, color, default_minutes, sort)
select v.name, v.color, v.mins, v.sort
from (values
  ('Muayene / kontrol', '#8FA9D3', 30, 1),
  ('Aşı', '#C9A564', 15, 2),
  ('Çip uygulama', '#8BB38B', 20, 3),
  ('Operasyon', '#A68BC0', 90, 4),
  ('Bakım', '#C99088', 30, 5)
) as v(name, color, mins, sort)
where not exists (select 1 from appointment_types);

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  animal_id uuid references animals(id),
  owner_id uuid references owners(id),
  -- Yeni hasta mini kaydı (hayvan kaydı yoksa)
  owner_name text,
  owner_phone varchar(16),
  animal_name text,
  animal_species varchar(20),
  vet_id uuid references users(id),
  type_id uuid references appointment_types(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  status varchar(12) not null default 'planned'
    check (status in ('planned', 'confirmed', 'arrived', 'in_exam', 'done', 'cancelled', 'no_show')),
  arrived_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  room varchar(20),
  walk_in boolean not null default false,
  cancel_reason text,
  cancelled_by_side varchar(6) check (cancelled_by_side in ('owner', 'clinic')),
  cancelled_at timestamptz,
  reminder boolean not null default true,
  version int not null default 1,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_time_chk check (ends_at > starts_at),
  constraint appointments_patient_chk check (animal_id is not null or animal_name is not null)
);

create index if not exists appointments_starts_idx on appointments (starts_at);
create index if not exists appointments_vet_starts_idx on appointments (vet_id, starts_at);
create index if not exists appointments_animal_idx on appointments (animal_id);

create table if not exists holidays (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  name text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists holidays_date_uq on holidays (date);
