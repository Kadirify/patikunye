CREATE TABLE "animal_owners" (
	"animal_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"from_date" date DEFAULT current_date NOT NULL,
	"to_date" date,
	CONSTRAINT "animal_owners_animal_id_owner_id_from_date_pk" PRIMARY KEY("animal_id","owner_id","from_date")
);
--> statement-breakpoint
CREATE TABLE "animals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"species" varchar(20) NOT NULL,
	"breed" text,
	"sex" varchar(10) NOT NULL,
	"neutered" boolean DEFAULT false NOT NULL,
	"neutered_at" date,
	"birth_date" date,
	"birth_date_estimated" boolean DEFAULT false NOT NULL,
	"color" text,
	"marks" text,
	"passport_no" varchar(40),
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"status_date" date,
	"allergies" text[] DEFAULT '{}'::text[] NOT NULL,
	"behavior" varchar(12),
	"source" varchar(20),
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"action" varchar(30) NOT NULL,
	"entity" varchar(30) NOT NULL,
	"entity_id" text,
	"summary" text,
	"diff" jsonb,
	"prev_hash" text,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chip_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"microchip_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinic" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"city" text,
	"district" text,
	"phone" text,
	"address" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "microchips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chip_no" varchar(20) NOT NULL,
	"format" varchar(10) NOT NULL,
	"animal_id" uuid NOT NULL,
	"implanted_at" date,
	"implanted_by" uuid,
	"body_site" varchar(30),
	"lot_no" text,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"tckn_enc" text,
	"tckn_hash" text,
	"tckn_last4" varchar(4),
	"birth_date" date,
	"phone" varchar(16),
	"phone2" varchar(16),
	"email" text,
	"city" text,
	"district" text,
	"address" text,
	"emergency_name" text,
	"emergency_phone" varchar(16),
	"preferred_channel" varchar(10) DEFAULT 'sms' NOT NULL,
	"notes" text,
	"kvkk_notice_at" timestamp with time zone,
	"reminder_consent" boolean DEFAULT true NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "petvet_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(20) NOT NULL,
	"animal_id" uuid NOT NULL,
	"owner_id" uuid,
	"vet_id" uuid,
	"source_type" varchar(20),
	"source_id" uuid,
	"event_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" varchar(15) DEFAULT 'pending' NOT NULL,
	"missing_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" uuid,
	"petvet_ref" text,
	"note" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(60) NOT NULL,
	"full_name" text NOT NULL,
	"role" varchar(20) NOT NULL,
	"password_hash" text NOT NULL,
	"pin_hash" text,
	"chamber_reg_no" text,
	"diploma_no" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "animal_owners" ADD CONSTRAINT "animal_owners_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_owners" ADD CONSTRAINT "animal_owners_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_events" ADD CONSTRAINT "chip_events_microchip_id_microchips_id_fk" FOREIGN KEY ("microchip_id") REFERENCES "public"."microchips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_events" ADD CONSTRAINT "chip_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microchips" ADD CONSTRAINT "microchips_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microchips" ADD CONSTRAINT "microchips_implanted_by_users_id_fk" FOREIGN KEY ("implanted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petvet_tasks" ADD CONSTRAINT "petvet_tasks_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petvet_tasks" ADD CONSTRAINT "petvet_tasks_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petvet_tasks" ADD CONSTRAINT "petvet_tasks_vet_id_users_id_fk" FOREIGN KEY ("vet_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petvet_tasks" ADD CONSTRAINT "petvet_tasks_done_by_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "animal_owners_owner_idx" ON "animal_owners" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "animals_passport_uq" ON "animals" USING btree ("passport_no") WHERE "animals"."passport_no" is not null and "animals"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "microchips_chip_no_uq" ON "microchips" USING btree ("chip_no") WHERE "microchips"."status" <> 'corrected';--> statement-breakpoint
CREATE INDEX "microchips_animal_idx" ON "microchips" USING btree ("animal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "owners_tckn_hash_uq" ON "owners" USING btree ("tckn_hash") WHERE "owners"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "owners_phone_idx" ON "owners" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "petvet_tasks_open_idx" ON "petvet_tasks" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "petvet_tasks_animal_idx" ON "petvet_tasks" USING btree ("animal_id");