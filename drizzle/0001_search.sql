-- Türkçe karakter ve büyük/küçük harf duyarsız arama.
-- unaccent() IMMUTABLE olmadığı için indekste kullanılamaz; sabit sözlüklü bir sarmalayıcı tanımlanır.
CREATE OR REPLACE FUNCTION pk_norm(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, lower(t)) $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS owners_name_trgm ON owners USING gin (pk_norm(first_name || ' ' || last_name) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS animals_name_trgm ON animals USING gin (pk_norm(name) gin_trgm_ops);
