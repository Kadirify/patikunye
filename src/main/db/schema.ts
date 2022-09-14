import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`)
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const clinic = pgTable('clinic', {
  id: id(),
  name: text('name').notNull(),
  city: text('city'),
  district: text('district'),
  phone: text('phone'),
  address: text('address'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: createdAt(),
})

export const users = pgTable('users', {
  id: id(),
  username: varchar('username', { length: 60 }).notNull().unique(),
  fullName: text('full_name').notNull(),
  role: varchar('role', { length: 20 }).notNull(), // admin | vet | tech | secretary
  passwordHash: text('password_hash').notNull(),
  pinHash: text('pin_hash'),
  chamberRegNo: text('chamber_reg_no'),
  diplomaNo: text('diploma_no'),
  active: boolean('active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const owners = pgTable(
  'owners',
  {
    id: id(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    tcknEnc: text('tckn_enc'),
    tcknHash: text('tckn_hash'),
    tcknLast4: varchar('tckn_last4', { length: 4 }),
    birthDate: date('birth_date'),
    phone: varchar('phone', { length: 16 }),
    phone2: varchar('phone2', { length: 16 }),
    email: text('email'),
    city: text('city'),
    district: text('district'),
    address: text('address'),
    emergencyName: text('emergency_name'),
    emergencyPhone: varchar('emergency_phone', { length: 16 }),
    preferredChannel: varchar('preferred_channel', { length: 10 }).notNull().default('sms'),
    notes: text('notes'),
    kvkkNoticeAt: timestamp('kvkk_notice_at', { withTimezone: true }),
    reminderConsent: boolean('reminder_consent').notNull().default(true),
    marketingConsentAt: timestamp('marketing_consent_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid('created_by').references(() => users.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('owners_tckn_hash_uq').on(t.tcknHash).where(sql`${t.deletedAt} is null`), index('owners_phone_idx').on(t.phone)],
)

export const animals = pgTable(
  'animals',
  {
    id: id(),
    name: text('name').notNull(),
    species: varchar('species', { length: 20 }).notNull(), // cat | dog | ferret | bird | rabbit | rodent | reptile | other
    breed: text('breed'),
    sex: varchar('sex', { length: 10 }).notNull(), // male | female | unknown
    neutered: boolean('neutered').notNull().default(false),
    neuteredAt: date('neutered_at'),
    birthDate: date('birth_date'),
    birthDateEstimated: boolean('birth_date_estimated').notNull().default(false),
    color: text('color'),
    marks: text('marks'),
    passportNo: varchar('passport_no', { length: 40 }),
    status: varchar('status', { length: 12 }).notNull().default('active'), // active | dead | lost
    statusDate: date('status_date'),
    allergies: text('allergies').array().notNull().default(sql`'{}'::text[]`),
    behavior: varchar('behavior', { length: 12 }), // shy | aggressive | bites
    source: varchar('source', { length: 20 }),
    notes: text('notes'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid('created_by').references(() => users.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('animals_passport_uq').on(t.passportNo).where(sql`${t.passportNo} is not null and ${t.deletedAt} is null`)],
)

export const animalOwners = pgTable(
  'animal_owners',
  {
    animalId: uuid('animal_id').notNull().references(() => animals.id),
    ownerId: uuid('owner_id').notNull().references(() => owners.id),
    isPrimary: boolean('is_primary').notNull().default(true),
    fromDate: date('from_date').notNull().default(sql`current_date`),
    toDate: date('to_date'),
  },
  (t) => [primaryKey({ columns: [t.animalId, t.ownerId, t.fromDate] }), index('animal_owners_owner_idx').on(t.ownerId)],
)

export const microchips = pgTable(
  'microchips',
  {
    id: id(),
    chipNo: varchar('chip_no', { length: 20 }).notNull(),
    format: varchar('format', { length: 10 }).notNull(), // iso | legacy
    animalId: uuid('animal_id').notNull().references(() => animals.id),
    implantedAt: date('implanted_at'),
    implantedBy: uuid('implanted_by').references(() => users.id),
    bodySite: varchar('body_site', { length: 30 }),
    lotNo: text('lot_no'),
    status: varchar('status', { length: 12 }).notNull().default('active'), // active | inactive | corrected
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('microchips_chip_no_uq').on(t.chipNo).where(sql`${t.status} <> 'corrected'`),
    index('microchips_animal_idx').on(t.animalId),
  ],
)

export const chipEvents = pgTable('chip_events', {
  id: id(),
  microchipId: uuid('microchip_id').notNull().references(() => microchips.id),
  kind: varchar('kind', { length: 20 }).notNull(), // IMPLANT | CORRECTION | DEACTIVATE
  data: jsonb('data').notNull().default({}),
  userId: uuid('user_id').references(() => users.id),
  at: createdAt(),
})

export const petvetTasks = pgTable(
  'petvet_tasks',
  {
    id: id(),
    kind: varchar('kind', { length: 20 }).notNull(),
    animalId: uuid('animal_id').notNull().references(() => animals.id),
    ownerId: uuid('owner_id').references(() => owners.id),
    vetId: uuid('vet_id').references(() => users.id),
    sourceType: varchar('source_type', { length: 20 }),
    sourceId: uuid('source_id'),
    eventDate: date('event_date').notNull(),
    dueDate: date('due_date').notNull(),
    status: varchar('status', { length: 15 }).notNull().default('pending'), // pending | missing_info | done | cancelled
    missingFields: text('missing_fields').array().notNull().default(sql`'{}'::text[]`),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneBy: uuid('done_by').references(() => users.id),
    petvetRef: text('petvet_ref'),
    note: text('note'),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('petvet_tasks_open_idx').on(t.status, t.dueDate), index('petvet_tasks_animal_idx').on(t.animalId)],
)

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: createdAt(),
    userId: uuid('user_id').references(() => users.id),
    action: varchar('action', { length: 30 }).notNull(), // create | update | delete | view_sensitive | export | login | login_failed
    entity: varchar('entity', { length: 30 }).notNull(),
    entityId: text('entity_id'),
    summary: text('summary'),
    diff: jsonb('diff'),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_logs_entity_idx').on(t.entity, t.entityId), index('audit_logs_at_idx').on(t.at)],
)
