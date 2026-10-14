-- Mesajlar ve hatırlatmalar

-- Hatırlatma kuyruğu: her satır tek bir gönderim (aynı aşı için 7 gün önce / 1 gün önce ayrı satırlardır)
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  kind varchar(24) not null,                       -- vaccine | appointment | appointment_confirm | appointment_cancel | control | custom
  owner_id uuid not null references owners(id),
  animal_id uuid references animals(id),
  source_type varchar(30) not null,
  source_id text not null,
  channel varchar(10) not null,                    -- sms | email
  to_address text,
  template_key varchar(40) not null,
  vars jsonb not null default '{}',
  body_override text,                              -- yalnizca bu mesaj icin ozel metin
  event_at timestamptz,                            -- olay zamanı (randevu saati / aşı vadesi)
  send_at timestamptz not null,
  status varchar(20) not null default 'planned',   -- planned | queued | sent | delivered | failed | permanent_failed | cancelled | no_consent | expired
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  provider_msg_id text,
  sent_at timestamptz,
  cancelled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reminders_due_idx on reminders (status, send_at);
create index if not exists reminders_source_idx on reminders (source_type, source_id);
create index if not exists reminders_animal_idx on reminders (animal_id);
create index if not exists reminders_owner_idx on reminders (owner_id);

-- Gönderilen her mesajın kaydı
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid references reminders(id),
  owner_id uuid references owners(id),
  channel varchar(10) not null,
  to_address text not null,
  body text not null,
  status varchar(20) not null,                     -- sent | delivered | failed
  provider varchar(20) not null,
  provider_msg_id text,
  error text,
  sent_at timestamptz not null default now(),
  cost_units int not null default 1,               -- SMS: segment sayısı, e-posta: 1
  sent_by uuid references users(id),
  is_test boolean not null default false
);
create index if not exists messages_sent_at_idx on messages (sent_at desc);
create index if not exists messages_owner_idx on messages (owner_id);

-- Şablonlar
create table if not exists message_templates (
  key varchar(40) not null,
  channel varchar(10) not null,
  subject text,
  body text not null,
  builtin boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (key, channel)
);

-- Sırlar (SMS API parolası, SMTP parolası): deps.crypto.encrypt ile şifreli; ayarlarda yalnızca anahtar adı
create table if not exists secrets_kv (
  key varchar(60) primary key,
  value_enc text not null,
  updated_at timestamptz not null default now()
);

-- Varsayılan Türkçe şablonlar
insert into message_templates (key, channel, subject, body, builtin) values
  ('vaccine_reminder', 'sms', null, 'Sayın {sahip_ad}, {hayvan_ad} için {asi_ad} aşısının zamanı {tarih}. Randevu için: {klinik_tel} - {klinik_ad}', true),
  ('vaccine_overdue', 'sms', null, 'Sayın {sahip_ad}, {hayvan_ad} için {asi_ad} aşısı {tarih} tarihinde yapılmalıydı. Gecikmemesi için lütfen bizi arayın: {klinik_tel} - {klinik_ad}', true),
  ('appointment_confirm', 'sms', null, 'Sayın {sahip_ad}, {hayvan_ad} için randevunuz {tarih} {saat} olarak oluşturuldu. Hekim: {hekim_ad}. {klinik_ad} {klinik_tel}', true),
  ('appointment_reminder', 'sms', null, 'Sayın {sahip_ad}, {hayvan_ad} için randevunuz {tarih} {saat}. Gelemeyecekseniz lütfen haber verin: {klinik_tel} - {klinik_ad}', true),
  ('appointment_cancel', 'sms', null, 'Sayın {sahip_ad}, {hayvan_ad} için {tarih} {saat} randevunuz iptal edilmiştir. Yeni randevu için: {klinik_tel} - {klinik_ad}', true),
  ('control_reminder', 'sms', null, 'Sayın {sahip_ad}, {hayvan_ad} için kontrol muayenesi zamanı {tarih}. Randevu için: {klinik_tel} - {klinik_ad}', true),
  ('vaccine_reminder', 'email', '{hayvan_ad} için aşı hatırlatması', E'Sayın {sahip_ad},\n\n{hayvan_ad} için {asi_ad} aşısının zamanı {tarih}.\nRandevu almak için bizi arayabilirsiniz: {klinik_tel}\n\n{klinik_ad}', true),
  ('vaccine_overdue', 'email', '{hayvan_ad} için gecikmiş aşı', E'Sayın {sahip_ad},\n\n{hayvan_ad} için {asi_ad} aşısı {tarih} tarihinde yapılmalıydı. Gecikmemesi için lütfen bizi arayın: {klinik_tel}\n\n{klinik_ad}', true),
  ('appointment_confirm', 'email', 'Randevunuz oluşturuldu', E'Sayın {sahip_ad},\n\n{hayvan_ad} için randevunuz {tarih} {saat} olarak oluşturuldu.\nHekim: {hekim_ad}\n\n{klinik_ad} - {klinik_tel}', true),
  ('appointment_reminder', 'email', 'Randevu hatırlatması', E'Sayın {sahip_ad},\n\n{hayvan_ad} için randevunuz {tarih} {saat}.\nGelemeyecekseniz lütfen haber verin: {klinik_tel}\n\n{klinik_ad}', true),
  ('appointment_cancel', 'email', 'Randevunuz iptal edildi', E'Sayın {sahip_ad},\n\n{hayvan_ad} için {tarih} {saat} randevunuz iptal edilmiştir.\nYeni randevu için: {klinik_tel}\n\n{klinik_ad}', true),
  ('control_reminder', 'email', '{hayvan_ad} için kontrol hatırlatması', E'Sayın {sahip_ad},\n\n{hayvan_ad} için kontrol muayenesi zamanı {tarih}.\nRandevu için: {klinik_tel}\n\n{klinik_ad}', true)
on conflict (key, channel) do nothing;
