// Raporlar ve yazdirma verisi
// Tüm raporlar diğer modüllerin tablolarını yalnızca OKUR. TCKN hiçbir yanıtta çözülmez: yalnızca son 4 hane (maskeli).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError, parse, requirePerm, requireUser, type AppDeps, type SessionUser } from '../context'
import { writeAudit } from '../audit'
import { getSettings } from '../settings'
import { addDaysIso, diffDaysIso, formatDateTr, PETVET_KIND_LABEL, todayIstanbul, type PetvetTaskKind } from '../../../shared/petvet'
import { formatTrPhone } from '../../../shared/identity'
import { SEX_LABEL, SPECIES_LABEL, type Sex, type Species } from '../../../shared/api-types'
import { can } from '../../../shared/permissions'
import { VACCINE_KIND_LABEL, type VaccineKind } from '../../../shared/vaccines'
import { SYSTEM_KEYS, SYSTEM_LABEL, VISIT_TYPE_LABEL, type VisitType } from '../../../shared/visits'
import { APPOINTMENT_STATUS_LABEL, type AppointmentStatus } from '../../../shared/appointments'
import { CHANNEL_LABEL, REMINDER_KIND_LABEL, type MessageChannel } from '../../../shared/messaging'
import { KVKK_CHANNEL_LABEL, KVKK_REQUEST_TYPE_LABEL, KVKK_STATUS_LABEL, type KvkkChannel, type KvkkRequestType, type KvkkStatus } from '../../../shared/admin'
import {
  REPORTS,
  fmtNum,
  pct,
  reportDef,
  reportToCsv,
  type AuditPackRow,
  type CellValue,
  type PrintAnimal,
  type PrintAppointmentCard,
  type PrintAuditPack,
  type PrintChipCard,
  type PrintClinic,
  type PrintEnvelope,
  type PrintKvkkConsent,
  type PrintKvkkResponse,
  type PrintOwner,
  type PrintVaccineCard,
  type PrintVisit,
  type PrintWorklist,
  type ReportChart,
  type ReportDef,
  type ReportKey,
  type ReportResult,
  type ReportTable,
  type ReportsMetaDto,
} from '../../../shared/reports'

type Row = Record<string, any>

const TZ = `'Europe/Istanbul'`
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih geçersiz (YYYY-AA-GG).')
const uuid = z.string().uuid('Geçersiz kayıt.')
/** Arayüze gönderilen tablolarda en fazla satır (CSV'de sınır yok) */
const UI_ROW_LIMIT = 2000

const PETVET_STATUS_LABEL: Record<string, string> = { pending: 'Bekliyor', missing_info: 'Eksik bilgi', done: 'Girildi', cancelled: 'İptal' }
const sp = (s: string) => SPECIES_LABEL[s as Species] ?? s
const vk = (k: string) => VACCINE_KIND_LABEL[k as VaccineKind] ?? k
const pk = (k: string) => PETVET_KIND_LABEL[k as PetvetTaskKind] ?? k
const maskLast4 = (last4: string | null | undefined) => (last4 ? '*******' + last4 : '')
const d = (v: unknown): string | null => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10))
const isoTs = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())
const pctStr = (v: number | null) => (v == null ? '-' : `%${fmtNum(v, 1)}`)

/** Ana (güncel) sahip - lateral alt sorgu (a = animals takma adı) */
const OWNER_LATERAL = `left join lateral (
    select o.id as owner_id, o.first_name || ' ' || o.last_name as owner_name, o.phone as owner_phone, o.tckn_last4 as owner_tckn_last4
    from animal_owners ao join owners o on o.id = ao.owner_id
    where ao.animal_id = a.id and ao.to_date is null order by ao.is_primary desc limit 1
  ) o on true`
const CHIP_LATERAL = `left join lateral (
    select m.chip_no from microchips m where m.animal_id = a.id and m.status = 'active' order by m.created_at desc limit 1
  ) mc on true`
/** Hekimin dokunduğu hayvan (muayene, aşı ya da çip uygulaması) - hekim boyutu olmayan raporlarda "kendi" kapsamı */
const touchedBy = (p: string) => `(
    exists (select 1 from visits vv where vv.animal_id = a.id and vv.vet_id = ${p} and vv.deleted_at is null)
    or exists (select 1 from vaccinations vx where vx.animal_id = a.id and vx.given_by = ${p} and vx.deleted_at is null)
    or exists (select 1 from microchips mx where mx.animal_id = a.id and mx.implanted_by = ${p}))`

/** Yaş metni: 2 yaş 3 ay / 5 ay */
function ageText(birth: string | null, today: string): string {
  if (!birth) return ''
  const [y1, m1, d1] = birth.split('-').map(Number)
  const [y2, m2, d2] = today.split('-').map(Number)
  let months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0)
  if (months < 0) months = 0
  const y = Math.floor(months / 12)
  const m = months % 12
  return y ? `${y} yaş${m ? ` ${m} ay` : ''}` : `${m} ay`
}
function ageYears(birth: string, today: string): number {
  return diffDaysIso(birth, today) / 365.25
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1)
  return m
}
const sortedEntries = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'))

interface Ctx {
  from: string
  to: string
  today: string
  vetId: string | null
  lot: string | null
}
type Built = Pick<ReportResult, 'summary' | 'chart' | 'tables'> & { notes?: string[] }

export function reportsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps
  const today = () => deps.today?.() ?? todayIstanbul(deps.now?.())
  const q = async (text: string, params: unknown[] = []): Promise<Row[]> => (await db.$client.query(text, params)).rows

  // ================================================================ rapor oluşturucular

  const builders: Record<ReportKey, (c: Ctx) => Promise<Built>> = {
    // ---- Kimliklendirme: dönemde uygulanan çipler
    async identification(c) {
      const p: unknown[] = [c.from, c.to]
      let vet = ''
      if (c.vetId) {
        p.push(c.vetId)
        vet = `and m.implanted_by = $${p.length}`
      }
      const rows = await q(
        `select m.implanted_at, m.chip_no, a.species, a.name as animal_name, o.owner_name, u.full_name as vet_name,
                t.status as pt_status, t.due_date, (t.done_at at time zone ${TZ})::date as done_date
           from microchips m
           join animals a on a.id = m.animal_id and a.deleted_at is null
           left join users u on u.id = m.implanted_by
           ${OWNER_LATERAL}
           left join lateral (
             select t.status, t.due_date, t.done_at from petvet_tasks t
             where t.kind = 'CHIP_NEW' and t.animal_id = a.id and t.status <> 'cancelled' and (t.source_id = m.id or t.source_id is null)
             order by (t.source_id = m.id) desc nulls last, t.created_at desc limit 1
           ) t on true
          where m.status <> 'corrected' and m.implanted_at between $1 and $2 ${vet}
          order by m.implanted_at, m.created_at`,
        p,
      )
      let done = 0
      let open = 0
      let late = 0
      const out = rows.map((r) => {
        let delay: number | null = null
        if (r.pt_status === 'done' && r.done_date && r.due_date) delay = Math.max(0, diffDaysIso(d(r.due_date)!, d(r.done_date)!))
        else if (r.pt_status && r.due_date) delay = Math.max(0, diffDaysIso(d(r.due_date)!, c.today))
        if (r.pt_status === 'done') done++
        else if (r.pt_status) open++
        if (delay) late++
        return {
          date: formatDateTr(d(r.implanted_at)),
          chipNo: r.chip_no,
          species: sp(r.species),
          animal: r.animal_name,
          owner: r.owner_name ?? '',
          vet: r.vet_name ?? '',
          petvet: r.pt_status ? PETVET_STATUS_LABEL[r.pt_status] : 'Görev yok',
          delay: delay || null,
        }
      })
      return {
        summary: [
          { label: 'Uygulanan çip', value: fmtNum(rows.length) },
          { label: 'PETVET girildi', value: fmtNum(done) },
          { label: 'Bekleyen', value: fmtNum(open) },
          { label: 'Gecikmeli', value: fmtNum(late) },
        ],
        chart: speciesChart('Türe göre çip uygulaması', rows.map((r) => r.species)),
        tables: [
          {
            title: 'Uygulanan çipler',
            columns: [
              { key: 'date', label: 'Tarih', mono: true },
              { key: 'chipNo', label: 'Çip no', mono: true },
              { key: 'species', label: 'Tür' },
              { key: 'animal', label: 'Hayvan' },
              { key: 'owner', label: 'Sahip' },
              { key: 'vet', label: 'Hekim' },
              { key: 'petvet', label: 'PETVET' },
              { key: 'delay', label: 'Gecikme (gün)', num: true },
            ],
            rows: out,
            empty: 'Bu dönemde çip uygulaması yok.',
          },
        ],
      }
    },

    // ---- PETVET uyum
    async petvet(c) {
      const p: unknown[] = [c.from, c.to]
      let vet = ''
      if (c.vetId) {
        p.push(c.vetId)
        vet = `and t.vet_id = $${p.length}`
      }
      const rows = await q(
        `select t.kind, t.status, t.event_date, t.due_date, (t.done_at at time zone ${TZ})::date as done_date,
                a.name as animal_name, a.species, mc.chip_no, o.owner_name, o.owner_phone, u.full_name as vet_name
           from petvet_tasks t
           join animals a on a.id = t.animal_id
           left join users u on u.id = t.vet_id
           ${OWNER_LATERAL}
           ${CHIP_LATERAL}
          where t.event_date between $1 and $2 and t.status <> 'cancelled' ${vet}
          order by t.due_date`,
        p,
      )
      type Agg = { total: number; done: number; onTime: number; daysSum: number; open: number; overdue: number; due: number }
      const agg = new Map<string, Agg>()
      const all: Agg = { total: 0, done: 0, onTime: 0, daysSum: 0, open: 0, overdue: 0, due: 0 }
      const overdueList: Record<string, CellValue>[] = []
      for (const r of rows) {
        const a = agg.get(r.kind) ?? { total: 0, done: 0, onTime: 0, daysSum: 0, open: 0, overdue: 0, due: 0 }
        agg.set(r.kind, a)
        const due = d(r.due_date)!
        const isDone = r.status === 'done'
        const isOverdue = !isDone && due < c.today
        const onTime = isDone && !!r.done_date && d(r.done_date)! <= due
        for (const x of [a, all]) {
          x.total++
          if (isDone) {
            x.done++
            x.daysSum += r.done_date ? Math.max(0, diffDaysIso(d(r.event_date)!, d(r.done_date)!)) : 0
          } else x.open++
          if (onTime) x.onTime++
          if (isOverdue) x.overdue++
          // Zamanında oranının paydası: girilmiş ya da son tarihi geçmiş görevler (süresi devam edenler hariç)
          if (isDone || isOverdue) x.due++
        }
        if (isOverdue) {
          overdueList.push({
            dueDate: formatDateTr(due),
            late: diffDaysIso(due, c.today),
            kind: pk(r.kind),
            animal: `${r.animal_name} (${sp(r.species)})`,
            chipNo: r.chip_no ?? '',
            owner: r.owner_name ?? '',
            phone: formatTrPhone(r.owner_phone),
            vet: r.vet_name ?? '',
            status: PETVET_STATUS_LABEL[r.status] ?? r.status,
          })
        }
      }
      const line = (label: string, x: Agg) => ({
        kind: label,
        total: x.total,
        done: x.done,
        onTime: x.onTime,
        onTimePct: pct(x.onTime, x.due),
        avgDays: x.done ? Math.round((x.daysSum / x.done) * 10) / 10 : null,
        open: x.open,
        overdue: x.overdue,
      })
      const byKind = [...agg.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, x]) => line(pk(k), x))
      if (byKind.length > 1) byKind.push(line('Toplam', all))
      const allPct = pct(all.onTime, all.due)
      return {
        summary: [
          { label: 'Görev', value: fmtNum(all.total) },
          { label: 'Girildi', value: fmtNum(all.done) },
          { label: 'Zamanında', value: pctStr(allPct) },
          { label: 'Ort. giriş süresi', value: all.done ? `${fmtNum(all.daysSum / all.done, 1)} gün` : '-' },
          { label: 'Geciken (açık)', value: fmtNum(all.overdue) },
        ],
        chart: {
          title: 'Tür bazında zamanında giriş oranı',
          unit: '%',
          bars: [...agg.entries()].map(([k, x]) => ({ label: pk(k), value: pct(x.onTime, x.due) ?? 0 })),
        },
        tables: [
          {
            title: 'Tür bazında',
            columns: [
              { key: 'kind', label: 'İş türü' },
              { key: 'total', label: 'Görev', num: true },
              { key: 'done', label: 'Girildi', num: true },
              { key: 'onTime', label: 'Zamanında', num: true },
              { key: 'onTimePct', label: 'Zamanında %', num: true },
              { key: 'avgDays', label: 'Ort. giriş (gün)', num: true },
              { key: 'open', label: 'Bekleyen', num: true },
              { key: 'overdue', label: 'Geciken', num: true },
            ],
            rows: byKind,
            empty: 'Bu dönemde PETVET görevi yok.',
          },
          {
            title: 'Geciken görevler (son tarihi geçmiş, girilmemiş)',
            columns: [
              { key: 'dueDate', label: 'Son tarih', mono: true },
              { key: 'late', label: 'Gecikme (gün)', num: true },
              { key: 'kind', label: 'İş' },
              { key: 'animal', label: 'Hayvan' },
              { key: 'chipNo', label: 'Çip no', mono: true },
              { key: 'owner', label: 'Sahip' },
              { key: 'phone', label: 'Telefon', mono: true },
              { key: 'vet', label: 'Hekim' },
              { key: 'status', label: 'Durum' },
            ],
            rows: overdueList,
            empty: 'Geciken görev yok.',
          },
        ],
        notes: ['Zamanında % = son tarihinde ya da öncesinde girilen görevler / (girilen + son tarihi geçmiş görevler). Süresi devam eden görevler paydaya katılmaz.'],
      }
    },

    // ---- Çipsiz hayvanlar (anlık durum, tarih aralığı yok)
    async chipless(c) {
      const p: unknown[] = [c.today]
      let vet = ''
      if (c.vetId) {
        p.push(c.vetId)
        vet = `and ${touchedBy(`$${p.length}`)}`
      }
      const rows = await q(
        `select a.name, a.species, a.breed, a.birth_date, a.birth_date_estimated, o.owner_name, o.owner_phone
           from animals a
           ${OWNER_LATERAL}
          where a.deleted_at is null and a.status = 'active' and a.species in ('cat', 'dog', 'ferret')
            and a.birth_date is not null and a.birth_date <= ($1::date - interval '6 months')::date
            and not exists (select 1 from microchips m where m.animal_id = a.id and m.status = 'active')
            ${vet}
          order by a.birth_date, a.name`,
        p,
      )
      return {
        summary: [{ label: 'Çipsiz hayvan', value: fmtNum(rows.length) }],
        chart: speciesChart('Türe göre çipsiz hayvan', rows.map((r) => r.species)),
        tables: [
          {
            title: 'Arama listesi',
            columns: [
              { key: 'animal', label: 'Hayvan' },
              { key: 'species', label: 'Tür' },
              { key: 'breed', label: 'Irk' },
              { key: 'birth', label: 'Doğum', mono: true },
              { key: 'age', label: 'Yaş' },
              { key: 'owner', label: 'Sahip' },
              { key: 'phone', label: 'Telefon', mono: true },
            ],
            rows: rows.map((r) => ({
              animal: r.name,
              species: sp(r.species),
              breed: r.breed ?? '',
              birth: (r.birth_date_estimated ? '~' : '') + formatDateTr(d(r.birth_date)),
              age: ageText(d(r.birth_date), c.today),
              owner: r.owner_name ?? '',
              phone: formatTrPhone(r.owner_phone),
            })),
            empty: '6 aydan büyük çipsiz kedi/köpek/gelincik yok.',
          },
        ],
        notes: ['Anlık durumdur; tarih aralığı uygulanmaz. Doğum tarihi bilinmeyen hayvanlar listede yoktur.'],
      }
    },

    // ---- Aşı raporu + lot geri çağırma
    async vaccines(c) {
      const p: unknown[] = [c.from, c.to]
      let vet = ''
      if (c.vetId) {
        p.push(c.vetId)
        vet = `and v.given_by = $${p.length}`
      }
      const rows = await q(
        `select v.kind, coalesce(pr.name, v.product_name, '-') as product, coalesce(v.lot_no, '') as lot_no, count(*)::int as n
           from vaccinations v left join vaccine_products pr on pr.id = v.product_id
          where v.deleted_at is null and not v.external and v.given_at between $1 and $2 ${vet}
          group by 1, 2, 3 order by 1, 2, 3`,
        p,
      )
      const total = rows.reduce((s, r) => s + r.n, 0)
      const rabies = rows.filter((r) => r.kind === 'rabies').reduce((s, r) => s + r.n, 0)
      const byKind = new Map<string, number>()
      for (const r of rows) byKind.set(vk(r.kind), (byKind.get(vk(r.kind)) ?? 0) + r.n)
      const tables: ReportTable[] = [
        {
          title: 'Tür / ürün / lot bazında',
          columns: [
            { key: 'kind', label: 'Aşı türü' },
            { key: 'product', label: 'Ürün' },
            { key: 'lot', label: 'Lot', mono: true },
            { key: 'n', label: 'Uygulama', num: true },
          ],
          rows: rows.map((r) => ({ kind: vk(r.kind), product: r.product, lot: r.lot_no, n: r.n })),
          empty: 'Bu dönemde uygulanan aşı yok.',
        },
      ]
      const notes: string[] = ['Başka klinikte yapılmış (dış) aşı kayıtları sayılmaz.']
      if (c.lot) {
        const lp: unknown[] = [c.lot]
        let lvet = ''
        if (c.vetId) {
          lp.push(c.vetId)
          lvet = `and v.given_by = $${lp.length}`
        }
        const recall = await q(
          `select v.given_at, a.name as animal_name, a.species, mc.chip_no, o.owner_name, o.owner_phone,
                  coalesce(pr.name, v.product_name, '-') as product, v.lot_no, u.full_name as vet_name
             from vaccinations v
             join animals a on a.id = v.animal_id and a.deleted_at is null
             left join vaccine_products pr on pr.id = v.product_id
             left join users u on u.id = v.given_by
             ${OWNER_LATERAL}
             ${CHIP_LATERAL}
            where v.deleted_at is null and lower(trim(v.lot_no)) = lower(trim($1)) ${lvet}
            order by v.given_at, a.name`,
          lp,
        )
        tables.push({
          title: `"${c.lot}" lotu kimlere yapıldı`,
          columns: [
            { key: 'date', label: 'Tarih', mono: true },
            { key: 'animal', label: 'Hayvan' },
            { key: 'chipNo', label: 'Çip no', mono: true },
            { key: 'owner', label: 'Sahip' },
            { key: 'phone', label: 'Telefon', mono: true },
            { key: 'product', label: 'Ürün' },
            { key: 'lot', label: 'Lot', mono: true },
            { key: 'vet', label: 'Hekim' },
          ],
          rows: recall.map((r) => ({
            date: formatDateTr(d(r.given_at)),
            animal: `${r.animal_name} (${sp(r.species)})`,
            chipNo: r.chip_no ?? '',
            owner: r.owner_name ?? '',
            phone: formatTrPhone(r.owner_phone),
            product: r.product,
            lot: r.lot_no ?? '',
            vet: r.vet_name ?? '',
          })),
          empty: 'Bu lot numarasıyla kayıt bulunamadı.',
        })
        notes.push('Lot araması tarih aralığından bağımsızdır (tüm kayıtlar).')
      }
      return {
        summary: [
          { label: 'Uygulanan aşı', value: fmtNum(total) },
          { label: 'Kuduz', value: fmtNum(rabies) },
          { label: 'Farklı lot', value: fmtNum(new Set(rows.filter((r) => r.lot_no).map((r) => r.lot_no)).size) },
        ],
        chart: { title: 'Aşı türüne göre', bars: sortedEntries(byKind).map(([label, value]) => ({ label, value })) },
        tables,
        notes,
      }
    },

    // ---- Aşı uyum oranı
    async 'vaccine-compliance'(c) {
      const to = c.to < c.today ? c.to : c.today
      const p: unknown[] = [c.from, to]
      let vet = ''
      if (c.vetId) {
        p.push(c.vetId)
        vet = `and ${touchedBy(`$${p.length}`)}`
      }
      const rows = await q(
        `select vp.kind, vp.dose_label, vp.due_date, vp.status, vx.given_at,
                a.name as animal_name, a.species, o.owner_name, o.owner_phone
           from vaccination_plans vp
           join animals a on a.id = vp.animal_id and a.deleted_at is null
           left join vaccinations vx on vx.id = vp.vaccination_id and vx.deleted_at is null
           ${OWNER_LATERAL}
          where vp.due_date between $1 and $2 and vp.status <> 'cancelled' ${vet}
          order by vp.due_date`,
        p,
      )
      type Agg = { total: number; onTime: number; late: number; external: number; missed: number }
      const z0 = (): Agg => ({ total: 0, onTime: 0, late: 0, external: 0, missed: 0 })
      const agg = new Map<string, Agg>()
      const all = z0()
      const missedList: Record<string, CellValue>[] = []
      for (const r of rows) {
        const a = agg.get(r.kind) ?? z0()
        agg.set(r.kind, a)
        const due = d(r.due_date)!
        let k: keyof Agg
        if (r.status === 'done') k = r.given_at && d(r.given_at)! > due ? 'late' : 'onTime'
        else if (r.status === 'external') k = 'external'
        else k = 'missed'
        for (const x of [a, all]) {
          x.total++
          x[k]++
        }
        if (k === 'missed' && due < c.today) {
          missedList.push({
            dueDate: formatDateTr(due),
            late: diffDaysIso(due, c.today),
            kind: vk(r.kind),
            dose: r.dose_label ?? '',
            animal: `${r.animal_name} (${sp(r.species)})`,
            owner: r.owner_name ?? '',
            phone: formatTrPhone(r.owner_phone),
          })
        }
      }
      const line = (label: string, x: Agg) => ({
        kind: label,
        total: x.total,
        onTime: x.onTime,
        late: x.late,
        external: x.external,
        missed: x.missed,
        rate: pct(x.onTime, x.total),
      })
      const byKind = [...agg.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, x]) => line(vk(k), x))
      if (byKind.length > 1) byKind.push(line('Toplam', all))
      return {
        summary: [
          { label: 'Vadesi gelen', value: fmtNum(all.total) },
          { label: 'Zamanında', value: fmtNum(all.onTime) },
          { label: 'Uyum oranı', value: pctStr(pct(all.onTime, all.total)) },
          { label: 'Yapılmadı', value: fmtNum(all.missed) },
        ],
        chart: {
          title: 'Aşı türüne göre uyum oranı',
          unit: '%',
          bars: [...agg.entries()].map(([k, x]) => ({ label: vk(k), value: pct(x.onTime, x.total) ?? 0 })),
        },
        tables: [
          {
            title: 'Aşı türü bazında',
            columns: [
              { key: 'kind', label: 'Aşı türü' },
              { key: 'total', label: 'Vadesi gelen', num: true },
              { key: 'onTime', label: 'Zamanında', num: true },
              { key: 'late', label: 'Geç yapıldı', num: true },
              { key: 'external', label: 'Başka klinikte', num: true },
              { key: 'missed', label: 'Yapılmadı', num: true },
              { key: 'rate', label: 'Uyum %', num: true },
            ],
            rows: byKind,
            empty: 'Bu dönemde vadesi gelen aşı yok.',
          },
          {
            title: 'Geciken aşılar (vadesi geçmiş, yapılmamış)',
            columns: [
              { key: 'dueDate', label: 'Vade', mono: true },
              { key: 'late', label: 'Gecikme (gün)', num: true },
              { key: 'kind', label: 'Aşı' },
              { key: 'dose', label: 'Doz' },
              { key: 'animal', label: 'Hayvan' },
              { key: 'owner', label: 'Sahip' },
              { key: 'phone', label: 'Telefon', mono: true },
            ],
            rows: missedList,
            empty: 'Geciken aşı yok.',
          },
        ],
        notes: ['Yalnızca vadesi bugüne kadar gelmiş planlar sayılır. Zamanında = vade tarihinde ya da öncesinde uygulanan. İptal edilen planlar hariç.'],
      }
    },

    // ---- Muayene istatistiği
    async visits(c) {
      const p: unknown[] = [c.from, c.to]
      let vet = ''
      if (c.vetId) {
        p.push(c.vetId)
        vet = `and v.vet_id = $${p.length}`
      }
      // Zincirde yalnızca geçerli versiyon sayılır (ek/düzeltme ayrı muayene değildir)
      const rows = await q(
        `select (v.visit_at at time zone ${TZ})::date as day, v.status, v.diagnoses, a.species, coalesce(u.full_name, '(hekim seçilmemiş)') as vet_name
           from visits v
           join animals a on a.id = v.animal_id
           left join users u on u.id = v.vet_id
          where v.deleted_at is null
            and not exists (select 1 from visits n where n.supersedes_id = v.id and n.deleted_at is null and n.status = 'signed')
            and (v.status = 'signed' or v.supersedes_id is null)
            and (v.visit_at at time zone ${TZ})::date between $1 and $2 ${vet}`,
        p,
      )
      const signed = rows.filter((r) => r.status === 'signed').length
      const byVet = countBy(rows, (r) => r.vet_name)
      const bySpecies = countBy(rows, (r) => sp(r.species))
      const byDay = countBy(rows, (r) => d(r.day)!)
      const diag = new Map<string, number>()
      for (const r of rows) for (const x of (r.diagnoses as string[]) ?? []) if (x.trim()) diag.set(x.trim(), (diag.get(x.trim()) ?? 0) + 1)
      const days = Math.max(1, diffDaysIso(c.from, c.to) + 1)
      const monthly = days > 62
      const chartMap = monthly ? countBy(rows, (r) => d(r.day)!.slice(0, 7)) : byDay
      return {
        summary: [
          { label: 'Muayene', value: fmtNum(rows.length) },
          { label: 'İmzalı', value: fmtNum(signed) },
          { label: 'Taslak', value: fmtNum(rows.length - signed) },
          { label: 'Günlük ortalama', value: fmtNum(rows.length / days, 1) },
        ],
        chart: {
          title: monthly ? 'Aylara göre muayene' : 'Günlere göre muayene',
          bars: [...chartMap.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([k, value]) => ({ label: monthly ? `${k.slice(5, 7)}.${k.slice(0, 4)}` : formatDateTr(k).slice(0, 5), value })),
        },
        tables: [
          { title: 'Hekim bazında', columns: [{ key: 'k', label: 'Hekim' }, { key: 'n', label: 'Muayene', num: true }], rows: sortedEntries(byVet).map(([k, n]) => ({ k, n })) },
          { title: 'Tür bazında', columns: [{ key: 'k', label: 'Tür' }, { key: 'n', label: 'Muayene', num: true }], rows: sortedEntries(bySpecies).map(([k, n]) => ({ k, n })) },
          {
            title: 'Gün bazında',
            columns: [{ key: 'k', label: 'Gün', mono: true }, { key: 'n', label: 'Muayene', num: true }],
            rows: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => ({ k: formatDateTr(k), n })),
          },
          {
            title: 'En sık tanılar',
            columns: [{ key: 'k', label: 'Tanı' }, { key: 'n', label: 'Muayene', num: true }],
            rows: sortedEntries(diag).slice(0, 20).map(([k, n]) => ({ k, n })),
            empty: 'Tanı girilmiş muayene yok.',
          },
        ].map((t) => ({ empty: 'Bu dönemde muayene yok.', ...t })),
        notes: ['Ek/düzeltme versiyonları ayrı muayene sayılmaz. Taslaklar dahildir.'],
      }
    },

    // ---- Hasta tabanı
    async patients(c) {
      const p: unknown[] = []
      let vet = ''
      if (c.vetId) {
        p.push(c.vetId)
        vet = `and ${touchedBy(`$${p.length}`)}`
      }
      const rows = await q(
        `select a.name, a.species, a.breed, a.birth_date, (a.created_at at time zone ${TZ})::date as created, o.owner_name, o.owner_phone,
                greatest(
                  (select max((x.visit_at at time zone ${TZ})::date) from visits x where x.animal_id = a.id and x.deleted_at is null),
                  (select max(x.given_at) from vaccinations x where x.animal_id = a.id and x.deleted_at is null),
                  (select max((x.starts_at at time zone ${TZ})::date) from appointments x where x.animal_id = a.id and x.status in ('arrived', 'in_exam', 'done')),
                  (a.created_at at time zone ${TZ})::date
                ) as last_seen
           from animals a
           ${OWNER_LATERAL}
          where a.deleted_at is null and a.status = 'active' ${vet}
          order by a.name`,
        p,
      )
      const limit12 = addDaysIso(c.today, -365)
      const newOnes = rows.filter((r) => d(r.created)! >= c.from && d(r.created)! <= c.to)
      const lost = rows.filter((r) => d(r.last_seen)! < limit12).sort((a, b) => d(a.last_seen)!.localeCompare(d(b.last_seen)!))
      const bySpecies = countBy(rows, (r) => sp(r.species))
      const byBreed = countBy(rows, (r) => `${sp(r.species)} - ${r.breed?.trim() || 'Belirtilmemiş'}`)
      const bands = ['0-1 yaş', '1-3 yaş', '3-7 yaş', '7-10 yaş', '10 yaş ve üstü', 'Bilinmiyor']
      const byAge = new Map<string, number>(bands.map((b) => [b, 0]))
      for (const r of rows) {
        const b = d(r.birth_date)
        let band = 'Bilinmiyor'
        if (b) {
          const y = ageYears(b, c.today)
          band = y < 1 ? bands[0] : y < 3 ? bands[1] : y < 7 ? bands[2] : y < 10 ? bands[3] : bands[4]
        }
        byAge.set(band, byAge.get(band)! + 1)
      }
      return {
        summary: [
          { label: 'Aktif hayvan', value: fmtNum(rows.length) },
          { label: 'Yeni hasta (dönem)', value: fmtNum(newOnes.length) },
          { label: '12 aydır gelmeyen', value: fmtNum(lost.length) },
        ],
        chart: { title: 'Türe göre aktif hayvan', bars: sortedEntries(bySpecies).map(([label, value]) => ({ label, value })) },
        tables: [
          { title: 'Tür dağılımı', columns: [{ key: 'k', label: 'Tür' }, { key: 'n', label: 'Hayvan', num: true }], rows: sortedEntries(bySpecies).map(([k, n]) => ({ k, n })) },
          { title: 'Irk dağılımı (ilk 25)', columns: [{ key: 'k', label: 'Tür - ırk' }, { key: 'n', label: 'Hayvan', num: true }], rows: sortedEntries(byBreed).slice(0, 25).map(([k, n]) => ({ k, n })) },
          { title: 'Yaş dağılımı', columns: [{ key: 'k', label: 'Yaş' }, { key: 'n', label: 'Hayvan', num: true }], rows: [...byAge.entries()].map(([k, n]) => ({ k, n })) },
          {
            title: '12 aydır gelmeyen hastalar',
            columns: [
              { key: 'lastSeen', label: 'Son geliş', mono: true },
              { key: 'animal', label: 'Hayvan' },
              { key: 'owner', label: 'Sahip' },
              { key: 'phone', label: 'Telefon', mono: true },
            ],
            rows: lost.map((r) => ({ lastSeen: formatDateTr(d(r.last_seen)), animal: `${r.name} (${sp(r.species)})`, owner: r.owner_name ?? '', phone: formatTrPhone(r.owner_phone) })),
            empty: '12 aydır gelmeyen aktif hasta yok.',
          },
        ].map((t) => ({ empty: 'Kayıt yok.', ...t })),
        notes: ['Dağılımlar anlık aktif hayvanlar içindir; tarih aralığı yalnızca "yeni hasta" sayısına uygulanır. Son geliş: muayene, aşı, gerçekleşen randevu ya da kayıt tarihinin en yenisi.'],
      }
    },

    // ---- Mesaj raporu
    async messages(c) {
      const rows = await q(
        `select m.channel, m.status, m.cost_units, r.kind
           from messages m left join reminders r on r.id = m.reminder_id
          where not m.is_test and (m.sent_at at time zone ${TZ})::date between $1 and $2`,
        [c.from, c.to],
      )
      const ok = (s: string) => s === 'sent' || s === 'delivered'
      type Agg = { total: number; ok: number; failed: number; units: number }
      const group = (key: (r: Row) => string) => {
        const m = new Map<string, Agg>()
        for (const r of rows) {
          const a = m.get(key(r)) ?? { total: 0, ok: 0, failed: 0, units: 0 }
          m.set(key(r), a)
          a.total++
          if (ok(r.status)) {
            a.ok++
            a.units += Number(r.cost_units) || 0
          } else a.failed++
        }
        return [...m.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, a]) => ({ k, ...a, rate: pct(a.ok, a.total) }))
      }
      const byChannel = group((r) => CHANNEL_LABEL[r.channel as MessageChannel] ?? r.channel)
      const byKind = group((r) => (r.kind ? (REMINDER_KIND_LABEL[r.kind] ?? r.kind) : 'Elle gönderilen'))
      const okCount = rows.filter((r) => ok(r.status)).length
      const units = rows.filter((r) => ok(r.status)).reduce((s, r) => s + (Number(r.cost_units) || 0), 0)
      const cols = (first: string) => [
        { key: 'k', label: first },
        { key: 'total', label: 'Gönderim', num: true },
        { key: 'ok', label: 'Başarılı', num: true },
        { key: 'failed', label: 'Başarısız', num: true },
        { key: 'rate', label: 'Başarı %', num: true },
        { key: 'units', label: 'Birim (SMS sayısı)', num: true },
      ]
      return {
        summary: [
          { label: 'Gönderim', value: fmtNum(rows.length) },
          { label: 'Başarılı', value: fmtNum(okCount) },
          { label: 'Başarısız', value: fmtNum(rows.length - okCount) },
          { label: 'Birim (maliyet tahmini)', value: fmtNum(units) },
        ],
        chart: { title: 'Kanala göre başarılı gönderim', bars: byChannel.map((r) => ({ label: r.k, value: r.ok })) },
        tables: [
          { title: 'Kanal bazında', columns: cols('Kanal'), rows: byChannel, empty: 'Bu dönemde mesaj gönderilmemiş.' },
          { title: 'Mesaj türü bazında', columns: cols('Tür'), rows: byKind, empty: 'Bu dönemde mesaj gönderilmemiş.' },
        ],
        notes: ['Maliyet = birim × sağlayıcının SMS birim fiyatı (SMS: Türkçe karakterli mesajda 67/70 karakterlik bölüm sayısı; e-posta 1). Test mesajları hariç.'],
      }
    },

    // ---- Randevu raporu
    async appointments(c) {
      const p: unknown[] = [c.from, c.to]
      let vet = ''
      if (c.vetId) {
        p.push(c.vetId)
        vet = `and ap.vet_id = $${p.length}`
      }
      const rows = await q(
        `select ap.status, ap.cancelled_by_side, ap.walk_in, coalesce(u.full_name, '(hekim yok)') as vet_name,
                extract(epoch from (ap.started_at - ap.arrived_at)) / 60.0 as wait_min
           from appointments ap left join users u on u.id = ap.vet_id
          where (ap.starts_at at time zone ${TZ})::date between $1 and $2 ${vet}`,
        p,
      )
      const CAME = ['arrived', 'in_exam', 'done']
      type Agg = { total: number; came: number; noShow: number; cancelOwner: number; cancelClinic: number; pending: number; waitSum: number; waitN: number; walkIn: number }
      const z0 = (): Agg => ({ total: 0, came: 0, noShow: 0, cancelOwner: 0, cancelClinic: 0, pending: 0, waitSum: 0, waitN: 0, walkIn: 0 })
      const all = z0()
      const byVet = new Map<string, Agg>()
      for (const r of rows) {
        const a = byVet.get(r.vet_name) ?? z0()
        byVet.set(r.vet_name, a)
        for (const x of [a, all]) {
          x.total++
          if (CAME.includes(r.status)) x.came++
          else if (r.status === 'no_show') x.noShow++
          else if (r.status === 'cancelled') r.cancelled_by_side === 'clinic' ? x.cancelClinic++ : x.cancelOwner++
          else x.pending++
          if (r.walk_in) x.walkIn++
          if (r.wait_min != null && Number(r.wait_min) >= 0) {
            x.waitSum += Number(r.wait_min)
            x.waitN++
          }
        }
      }
      const line = (k: string, x: Agg) => ({
        k,
        total: x.total,
        came: x.came,
        noShow: x.noShow,
        cancelled: x.cancelOwner + x.cancelClinic,
        showRate: pct(x.came, x.came + x.noShow),
        wait: x.waitN ? Math.round((x.waitSum / x.waitN) * 10) / 10 : null,
      })
      const vetRows = [...byVet.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, x]) => line(k, x))
      if (vetRows.length > 1) vetRows.push(line('Toplam', all))
      const statusCount = countBy(rows, (r) => APPOINTMENT_STATUS_LABEL[r.status as AppointmentStatus] ?? r.status)
      return {
        summary: [
          { label: 'Randevu', value: fmtNum(all.total) },
          { label: 'Geldi', value: fmtNum(all.came) },
          { label: 'Gelmedi', value: fmtNum(all.noShow) },
          { label: 'İptal', value: fmtNum(all.cancelOwner + all.cancelClinic) },
          { label: 'Gelme oranı', value: pctStr(pct(all.came, all.came + all.noShow)) },
          { label: 'Ort. bekleme', value: all.waitN ? `${fmtNum(all.waitSum / all.waitN, 1)} dk` : '-' },
        ],
        chart: { title: 'Duruma göre randevular', bars: sortedEntries(statusCount).map(([label, value]) => ({ label, value })) },
        tables: [
          {
            title: 'Hekim bazında',
            columns: [
              { key: 'k', label: 'Hekim' },
              { key: 'total', label: 'Randevu', num: true },
              { key: 'came', label: 'Geldi', num: true },
              { key: 'noShow', label: 'Gelmedi', num: true },
              { key: 'cancelled', label: 'İptal', num: true },
              { key: 'showRate', label: 'Gelme %', num: true },
              { key: 'wait', label: 'Ort. bekleme (dk)', num: true },
            ],
            rows: vetRows,
            empty: 'Bu dönemde randevu yok.',
          },
          {
            title: 'İptal ve diğer',
            columns: [{ key: 'k', label: 'Kalem' }, { key: 'n', label: 'Sayı', num: true }],
            rows: [
              { k: 'Sahip iptali', n: all.cancelOwner },
              { k: 'Klinik iptali', n: all.cancelClinic },
              { k: 'Henüz sonuçlanmamış (planlı / onaylı)', n: all.pending },
              { k: 'Randevusuz gelen (walk-in)', n: all.walkIn },
            ],
          },
        ],
        notes: ['Gelme orani = geldi / (geldi + gelmedi). Bekleme = bekleme salonuna gelis -> muayeneye alinma.'],
      }
    },
  }

  function speciesChart(title: string, species: string[]): ReportChart {
    return { title, bars: sortedEntries(countBy(species, sp)).map(([label, value]) => ({ label, value })) }
  }

  // ================================================================ rapor ucu ortak kısmı

  const filterSchema = z
    .object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      vetId: uuid.optional().or(z.literal('').transform(() => undefined)),
      lot: z.string().trim().max(60).optional(),
    })
    .refine((f) => !f.from || !f.to || f.from <= f.to, 'Başlangıç tarihi bitişten sonra olamaz.')

  function checkReportAccess(u: SessionUser, key: string): ReportDef {
    const def = reportDef(key)
    if (!def) throw new AppError(404, 'Rapor bulunamadı.', 'NOT_FOUND')
    if (!def.roles.includes(u.role)) throw new AppError(403, 'Bu raporu görme yetkiniz yok.', 'FORBIDDEN')
    return def
  }

  async function runReport(u: SessionUser, key: string, query: unknown): Promise<ReportResult> {
    const def = checkReportAccess(u, key)
    const f = parse(filterSchema, query ?? {})
    const t = today()
    const from = f.from ?? t.slice(0, 8) + '01'
    const to = f.to ?? t
    if (diffDaysIso(from, to) > 3700) throw new AppError(400, 'Tarih aralığı en fazla 10 yıl olabilir.', 'VALIDATION')
    // Hekim rolü yalnızca kendi verisini görür (: "H ✓ (kendi)")
    const vetId = def.usesVet ? (u.role === 'vet' ? u.id : (f.vetId ?? null)) : null
    const built = await builders[def.key]({ from, to, today: t, vetId, lot: f.lot || null })
    const vetName = vetId ? ((await q('select full_name from users where id = $1', [vetId]))[0]?.full_name ?? null) : null
    return {
      key: def.key,
      title: def.title,
      from,
      to,
      vetId,
      vetName,
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
      summary: built.summary,
      chart: built.chart,
      tables: built.tables,
      notes: built.notes,
    }
  }

  const trimRows = (r: ReportResult): ReportResult => ({
    ...r,
    tables: r.tables.map((t) => (t.rows.length > UI_ROW_LIMIT ? { ...t, rows: t.rows.slice(0, UI_ROW_LIMIT), total: t.rows.length } : t)),
  })

  app.get('/api/reports/meta', async (req) => {
    const u = requirePerm(req, 'reports.view')
    const vets = await q(`select id, full_name from users where active and role in ('vet', 'admin') order by full_name`)
    return {
      reports: REPORTS.filter((r) => r.roles.includes(u.role)),
      vets: vets.map((v) => ({ id: v.id, fullName: v.full_name })),
      fixedVetId: u.role === 'vet' ? u.id : null,
      canExport: can(u.role, 'reports.export'),
      canAuditPack: can(u.role, 'petvet.audit_pack'),
      today: today(),
    } satisfies ReportsMetaDto
  })

  app.get('/api/reports/:key', async (req) => {
    const u = requirePerm(req, 'reports.view')
    const { key } = parse(z.object({ key: z.string() }), req.params)
    return trimRows(await runReport(u, key, req.query))
  })

  app.get('/api/reports/:key/csv', async (req, reply) => {
    const u = requirePerm(req, 'reports.view', 'reports.export')
    const { key } = parse(z.object({ key: z.string() }), req.params)
    const r = await runReport(u, key, req.query)
    await writeAudit(db, {
      userId: u.id,
      action: 'export',
      entity: 'report',
      entityId: key,
      summary: `${r.title} raporu CSV (${formatDateTr(r.from)}-${formatDateTr(r.to)}${r.vetName ? ', ' + r.vetName : ''})`,
    })
    const name = `PatiKunye_${key}_${r.from}_${r.to}.csv`
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Access-Control-Expose-Headers', 'Content-Disposition')
    return reportToCsv(r)
  })

  // ================================================================ yazdırma verisi (GET /api/print/:kind/:id?)

  async function clinicInfo(): Promise<PrintClinic> {
    const [c] = await q('select name, address, city, district, phone from clinic limit 1')
    return { name: c?.name ?? '', address: c?.address ?? null, city: c?.city ?? null, district: c?.district ?? null, phone: c?.phone ?? null }
  }

  async function loadAnimal(id: string): Promise<PrintAnimal> {
    const [a] = await q(
      `select a.id, a.name, a.species, a.breed, a.sex, a.color, a.birth_date, a.birth_date_estimated, a.neutered, a.passport_no, a.status,
              mc.chip_no, mc.implanted_at, mc.body_site, mu.full_name as chip_vet
         from animals a
         left join lateral (select m.* from microchips m where m.animal_id = a.id and m.status = 'active' order by m.created_at desc limit 1) mc on true
         left join users mu on mu.id = mc.implanted_by
        where a.id = $1 and a.deleted_at is null`,
      [id],
    )
    if (!a) throw new AppError(404, 'Hayvan bulunamadı.', 'NOT_FOUND')
    return {
      id: a.id,
      name: a.name,
      species: a.species,
      speciesLabel: sp(a.species),
      breed: a.breed,
      sex: a.sex,
      sexLabel: SEX_LABEL[a.sex as Sex] ?? a.sex,
      color: a.color,
      birthDate: d(a.birth_date),
      birthDateEstimated: a.birth_date_estimated,
      neutered: a.neutered,
      passportNo: a.passport_no,
      status: a.status,
      chipNo: a.chip_no ?? null,
      chipImplantedAt: d(a.implanted_at),
      chipBodySite: a.body_site ?? null,
      chipVetName: a.chip_vet ?? null,
    }
  }

  const OWNER_COLS = `o.id, o.first_name, o.last_name, o.tckn_last4, o.phone, o.email, o.address, o.city, o.district`
  const toOwner = (o: Row): PrintOwner => ({
    id: o.id,
    fullName: `${o.first_name} ${o.last_name}`,
    tcknMasked: maskLast4(o.tckn_last4),
    phone: o.phone ? formatTrPhone(o.phone) : null,
    email: o.email,
    address: o.address,
    city: o.city,
    district: o.district,
  })
  async function ownerOfAnimal(animalId: string): Promise<PrintOwner | null> {
    const [o] = await q(
      `select ${OWNER_COLS} from animal_owners ao join owners o on o.id = ao.owner_id
        where ao.animal_id = $1 and ao.to_date is null order by ao.is_primary desc limit 1`,
      [animalId],
    )
    return o ? toOwner(o) : null
  }
  async function ownerById(id: string): Promise<PrintOwner> {
    const [o] = await q(`select ${OWNER_COLS} from owners o where o.id = $1 and o.deleted_at is null`, [id])
    if (!o) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
    return toOwner(o)
  }

  const needId = (id: string | undefined, what: string) => {
    if (!id) throw new AppError(400, `${what} belirtilmedi.`, 'VALIDATION')
    return parse(uuid, id)
  }

  /** Muayene içeriği izni: visits.read ya da (ayar açıksa) sekreter */
  async function requireVisitRead(req: FastifyRequest): Promise<SessionUser> {
    const u = requireUser(req)
    if (can(u.role, 'visits.read')) return u
    if (u.role === 'secretary' && (await getSettings(db)).visits.secretaryCanRead) return u
    throw new AppError(403, 'Bu işlem için yetkiniz yok.', 'FORBIDDEN')
  }

  async function printVisit(id: string, full: boolean): Promise<PrintVisit> {
    const [v] = await q(
      `select v.*, u.full_name as vet_name, u.chamber_reg_no as vet_reg_no
         from visits v left join users u on u.id = v.vet_id
        where v.id = $1 and v.deleted_at is null`,
      [id],
    )
    if (!v) throw new AppError(404, 'Muayene bulunamadı.', 'NOT_FOUND')
    const tr = await q(
      `select drug, active_ingredient, dose, dose_unit, total_dose, per_kg, route, frequency, duration, kind, e_recete_no, note
         from treatments where visit_id = $1 order by sort, created_at`,
      [id],
    )
    const f = (v.findings ?? {}) as { vitals?: Record<string, unknown>; systems?: Record<string, { status: string; note?: string }> }
    const vt = f.vitals ?? {}
    const num = (x: unknown) => String(x).replace('.', ',')
    const vitals: { label: string; value: string }[] = []
    const add = (k: string, label: string, unit: string) => {
      if (vt[k] != null && vt[k] !== '') vitals.push({ label, value: `${num(vt[k])}${unit}` })
    }
    add('temp', 'Ateş', ' °C')
    add('pulse', 'Nabız', ' /dk')
    add('resp', 'Solunum', ' /dk')
    add('weight', 'Kilo', ' kg')
    add('bcs', 'VKS', ' /9')
    add('crt', 'KDZ', ' sn')
    add('dehydration', 'Dehidrasyon', ' %')
    add('mucosa', 'Mukoza', '')
    const systems = SYSTEM_KEYS.filter((k) => f.systems?.[k]).map((k) => ({
      label: SYSTEM_LABEL[k],
      status: f.systems![k].status === 'abnormal' ? 'Anormal' : 'Normal',
      note: f.systems![k].note ?? null,
    }))
    return {
      full,
      animal: await loadAnimal(v.animal_id),
      owner: await ownerOfAnimal(v.animal_id),
      visit: {
        id: v.id,
        visitAt: isoTs(v.visit_at)!,
        typeLabel: VISIT_TYPE_LABEL[v.type as VisitType] ?? v.type,
        status: v.status,
        version: v.version,
        vetName: v.vet_name,
        vetRegNo: v.vet_reg_no,
        signedAt: isoTs(v.signed_at),
        subjective: v.subjective,
        vitals,
        systems,
        assessment: v.assessment,
        diagnoses: v.diagnoses ?? [],
        differential: full ? (v.differential ?? []) : [],
        planText: v.plan_text,
        tests: v.tests,
        ownerAdvice: v.owner_advice,
        // İç not yalnızca tam sürümde
        internalNote: full ? v.internal_note : null,
        controlDate: d(v.control_date),
        amendReason: full ? v.amend_reason : null,
      },
      treatments: tr.map((t) => {
        let dose: string | null = null
        if (t.dose != null) {
          dose = `${num(Number(t.dose))} ${t.dose_unit ?? ''}`.trim()
          if (t.per_kg && t.total_dose != null) dose += ` (toplam ${num(Number(t.total_dose))} ${String(t.dose_unit ?? '').replace('/kg', '')})`
        }
        return {
          drug: t.drug,
          activeIngredient: t.active_ingredient,
          dose,
          route: t.route,
          frequency: t.frequency,
          duration: t.duration,
          kind: t.kind,
          eReceteNo: t.e_recete_no,
          note: t.note,
        }
      }),
    }
  }

  async function printAuditPack(u: SessionUser, query: Row): Promise<PrintAuditPack> {
    const f = parse(
      z
        .object({
          from: isoDate,
          to: isoDate,
          kinds: z.string().optional(),
          vetId: uuid.optional().or(z.literal('').transform(() => undefined)),
          doneOnly: z.string().optional(),
        })
        .refine((x) => x.from <= x.to, 'Başlangıç tarihi bitişten sonra olamaz.'),
      { ...query, from: query.from || undefined, to: query.to || undefined },
    )
    const kinds = (f.kinds ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const doneOnly = f.doneOnly === '1' || f.doneOnly === 'true'
    const p: unknown[] = [f.from, f.to]
    let extra = ''
    if (kinds.length) {
      p.push(kinds)
      extra += ` and t.kind = any($${p.length})`
    }
    if (f.vetId) {
      p.push(f.vetId)
      extra += ` and t.vet_id = $${p.length}`
    }
    extra += doneOnly ? ` and t.status = 'done'` : ` and t.status <> 'cancelled'`
    const rows = await q(
      `select t.id, t.kind, t.status, t.event_date, t.due_date, (t.done_at at time zone ${TZ})::date as done_date, t.petvet_ref,
              a.name as animal_name, a.species, u.full_name as vet_name,
              ow.first_name || ' ' || ow.last_name as owner_name, ow.tckn_last4,
              (select m.chip_no from microchips m where m.animal_id = a.id and m.status <> 'corrected' order by (m.status = 'active') desc, m.created_at desc limit 1) as chip_no
         from petvet_tasks t
         join animals a on a.id = t.animal_id
         left join owners ow on ow.id = t.owner_id
         left join users u on u.id = t.vet_id
        where t.event_date between $1 and $2 ${extra}
        order by t.event_date, t.created_at`,
      p,
    )
    const ids = rows.map((r) => r.id)
    const att = ids.length
      ? await q(
          `select x.task_id, x.file_name, x.size, x.created_at from (
             select at.owner_id as task_id, at.file_name, at.size, at.created_at from attachments at
              where at.owner_type = 'petvet_task' and at.owner_id = any($1) and at.deleted_at is null
             union
             select t.id, at.file_name, at.size, at.created_at from petvet_tasks t join attachments at on at.id = t.evidence_attachment_id
              where t.id = any($1) and at.deleted_at is null
           ) x order by x.created_at`,
          [ids],
        )
      : []
    const attByTask = new Map<string, Row[]>()
    for (const a of att) attByTask.set(a.task_id, [...(attByTask.get(a.task_id) ?? []), a])
    const t = today()
    const out: AuditPackRow[] = rows.map((r) => {
      const ev = d(r.event_date)!
      const due = d(r.due_date)!
      const done = d(r.done_date)
      return {
        kind: r.kind,
        kindLabel: pk(r.kind),
        chipNo: r.chip_no,
        animalName: r.animal_name,
        speciesLabel: sp(r.species),
        ownerName: r.owner_name ?? null,
        tcknMasked: maskLast4(r.tckn_last4),
        eventDate: ev,
        dueDate: due,
        status: r.status,
        statusLabel: PETVET_STATUS_LABEL[r.status] ?? r.status,
        doneDate: done,
        daysToEntry: done ? diffDaysIso(ev, done) : null,
        lateDays: done ? diffDaysIso(due, done) : due < t ? diffDaysIso(due, t) : null,
        petvetRef: r.petvet_ref,
        vetName: r.vet_name,
        attachments: (attByTask.get(r.id) ?? []).map((a) => a.file_name),
      }
    })
    const sum = new Map<string, PrintAuditPack['summary'][number]>()
    for (const r of out) {
      const s = sum.get(r.kindLabel) ?? { kindLabel: r.kindLabel, total: 0, done: 0, onTime: 0, late: 0, open: 0 }
      sum.set(r.kindLabel, s)
      s.total++
      if (r.status === 'done') {
        s.done++
        if ((r.lateDays ?? 0) <= 0) s.onTime++
        else s.late++
      } else s.open++
    }
    const vetName = f.vetId ? ((await q('select full_name from users where id = $1', [f.vetId]))[0]?.full_name ?? null) : null
    await writeAudit(db, {
      userId: u.id,
      action: 'export',
      entity: 'petvet_audit_pack',
      summary: `PETVET denetim paketi ${formatDateTr(f.from)}-${formatDateTr(f.to)} (${out.length} görev)`,
    })
    const taskLabel = new Map(out.map((r, i) => [ids[i], `${r.kindLabel} - ${r.animalName} - ${formatDateTr(r.eventDate)}`]))
    return {
      from: f.from,
      to: f.to,
      vetName,
      kinds: kinds.map(pk),
      doneOnly,
      summary: [...sum.values()],
      rows: out,
      attachments: att.map((a) => ({ taskLabel: taskLabel.get(a.task_id) ?? '', fileName: a.file_name, size: a.size, createdAt: isoTs(a.created_at)! })),
      fileName: `PatiKunye_Denetim_${f.from}_${f.to}.pdf`,
    }
  }

  async function printWorklist(req: FastifyRequest, query: Row): Promise<PrintWorklist> {
    const f = parse(
      z.object({
        list: z.enum(['petvet', 'vaccine-calls'], { message: 'Liste türü petvet ya da vaccine-calls olmalı.' }),
        days: z.coerce.number().int().min(0).max(90).optional(),
        vetId: uuid.optional().or(z.literal('').transform(() => undefined)),
      }),
      query,
    )
    const t = today()
    if (f.list === 'petvet') {
      requirePerm(req, 'petvet.read')
      const p: unknown[] = []
      let vet = ''
      if (f.vetId) {
        p.push(f.vetId)
        vet = `and t.vet_id = $1`
      }
      const rows = await q(
        `select t.kind, t.status, t.due_date, a.name as animal_name, a.species, mc.chip_no, o.owner_name, o.owner_phone, u.full_name as vet_name
           from petvet_tasks t
           join animals a on a.id = t.animal_id
           left join users u on u.id = t.vet_id
           ${OWNER_LATERAL}
           ${CHIP_LATERAL}
          where t.status in ('pending', 'missing_info') ${vet}
          order by t.due_date, a.name`,
        p,
      )
      return {
        list: 'petvet',
        title: 'PETVET iş listesi (bekleyen görevler)',
        columns: [
          { key: 'due', label: 'Son tarih', mono: true },
          { key: 'left', label: 'Kalan', num: true },
          { key: 'kind', label: 'İş' },
          { key: 'animal', label: 'Hayvan' },
          { key: 'chipNo', label: 'Çip no', mono: true },
          { key: 'owner', label: 'Sahip' },
          { key: 'phone', label: 'Telefon', mono: true },
          { key: 'vet', label: 'Hekim' },
          { key: 'status', label: 'Durum' },
          { key: 'ref', label: 'PETVET ref. / not' },
        ],
        rows: rows.map((r) => ({
          due: formatDateTr(d(r.due_date)),
          left: diffDaysIso(t, d(r.due_date)!),
          kind: pk(r.kind),
          animal: `${r.animal_name} (${sp(r.species)})`,
          chipNo: r.chip_no ?? '',
          owner: r.owner_name ?? '',
          phone: formatTrPhone(r.owner_phone),
          vet: r.vet_name ?? '',
          status: PETVET_STATUS_LABEL[r.status],
          ref: '',
        })),
      }
    }
    requirePerm(req, 'animals.read')
    const days = f.days ?? 7
    const rows = await q(
      `select vp.kind, vp.dose_label, vp.due_date, a.name as animal_name, a.species, o.owner_name, o.owner_phone
         from vaccination_plans vp
         join animals a on a.id = vp.animal_id and a.deleted_at is null and a.status = 'active'
         ${OWNER_LATERAL}
        where vp.status in ('planned', 'postponed') and vp.due_date <= $1
        order by vp.due_date, a.name`,
      [addDaysIso(t, days)],
    )
    return {
      list: 'vaccine-calls',
      title: `Aşı arama listesi (geciken + ${days} gün içinde vadesi gelen)`,
      columns: [
        { key: 'due', label: 'Vade', mono: true },
        { key: 'left', label: 'Kalan', num: true },
        { key: 'kind', label: 'Aşı' },
        { key: 'dose', label: 'Doz' },
        { key: 'animal', label: 'Hayvan' },
        { key: 'owner', label: 'Sahip' },
        { key: 'phone', label: 'Telefon', mono: true },
        { key: 'called', label: 'Arandı / not' },
      ],
      rows: rows.map((r) => ({
        due: formatDateTr(d(r.due_date)),
        left: diffDaysIso(t, d(r.due_date)!),
        kind: vk(r.kind),
        dose: r.dose_label ?? '',
        animal: `${r.animal_name} (${sp(r.species)})`,
        owner: r.owner_name ?? '',
        phone: formatTrPhone(r.owner_phone),
        called: '',
      })),
    }
  }

  async function printHandler(req: FastifyRequest): Promise<PrintEnvelope> {
    const { kind, id } = parse(z.object({ kind: z.string(), id: z.string().optional() }), req.params)
    const query = (req.query ?? {}) as Row
    let data: unknown
    switch (kind) {
      case 'vaccine-card': {
        requirePerm(req, 'animals.read')
        const animalId = needId(id, 'Hayvan')
        const animal = await loadAnimal(animalId)
        const vacc = await q(
          `select v.given_at, v.kind, coalesce(pr.name, v.product_name, '') as product, v.lot_no, v.dose_label, v.external, v.external_clinic, u.full_name as vet_name
             from vaccinations v left join vaccine_products pr on pr.id = v.product_id left join users u on u.id = v.given_by
            where v.animal_id = $1 and v.deleted_at is null order by v.given_at, v.created_at`,
          [animalId],
        )
        const plans = await q(
          `select due_date, kind, dose_label from vaccination_plans where animal_id = $1 and status in ('planned', 'postponed') order by due_date`,
          [animalId],
        )
        data = {
          animal,
          owner: await ownerOfAnimal(animalId),
          vaccinations: vacc.map((v) => ({
            givenAt: d(v.given_at)!,
            kindLabel: vk(v.kind),
            product: v.product,
            lotNo: v.lot_no,
            doseLabel: v.dose_label,
            vetName: v.vet_name,
            external: v.external,
            externalClinic: v.external_clinic,
          })),
          upcoming: plans.map((p) => ({ dueDate: d(p.due_date)!, kindLabel: vk(p.kind), doseLabel: p.dose_label })),
        } satisfies PrintVaccineCard
        break
      }
      case 'chip-card': {
        requirePerm(req, 'animals.read')
        const animalId = needId(id, 'Hayvan')
        data = {
          animal: await loadAnimal(animalId),
          owner: await ownerOfAnimal(animalId),
          showOwner: query.owner === '1' || query.owner === 'true',
        } satisfies PrintChipCard
        break
      }
      case 'visit':
      case 'prescription': {
        const u = await requireVisitRead(req)
        const full = kind === 'visit' && (query.full === '1' || query.full === 'true')
        // İç notlu tam sürüm yalnızca muayene yazma yetkisi olanlara (hekim/yönetici/teknisyen)
        if (full && !can(u.role, 'visits.read')) throw new AppError(403, 'Tam sürümü yazdırma yetkiniz yok.', 'FORBIDDEN')
        data = await printVisit(needId(id, 'Muayene'), full)
        break
      }
      case 'kvkk-consent': {
        requirePerm(req, 'owners.read')
        const owner = await ownerById(needId(id, 'Sahip'))
        const animalId = typeof query.animalId === 'string' && query.animalId ? parse(uuid, query.animalId) : null
        const texts = await q(`select distinct on (kind) kind, version, body from kvkk_texts where kind in ('notice', 'consent') order by kind, version desc`)
        const clinic = await clinicInfo()
        const fill = (s: string) => s.replace(/\{klinik_ad\}/g, clinic.name)
        const t = (k: string) => {
          const r = texts.find((x) => x.kind === k)
          return r ? { version: r.version as number, body: fill(r.body) } : null
        }
        data = { owner, animal: animalId ? await loadAnimal(animalId) : null, notice: t('notice'), consent: t('consent') } satisfies PrintKvkkConsent
        break
      }
      case 'audit-pack': {
        const u = requirePerm(req, 'petvet.audit_pack')
        data = await printAuditPack(u, query)
        break
      }
      case 'kvkk-response': {
        const u = requirePerm(req, 'kvkk.requests')
        const rid = needId(id, 'Talep')
        const [r] = await q(
          `select r.*, c.full_name as closed_by_name from kvkk_requests r left join users c on c.id = r.closed_by where r.id = $1`,
          [rid],
        )
        if (!r) throw new AppError(404, 'KVKK talebi bulunamadı.', 'NOT_FOUND')
        const [o] = await q(`select ${OWNER_COLS} from owners o where o.id = $1`, [r.owner_id])
        await writeAudit(db, { userId: u.id, action: 'export', entity: 'kvkk_request', entityId: rid, summary: 'KVKK talep yanıtı yazdırıldı' })
        data = {
          owner: toOwner(o),
          request: {
            id: r.id,
            type: r.type,
            typeLabel: KVKK_REQUEST_TYPE_LABEL[r.type as KvkkRequestType] ?? r.type,
            channelLabel: KVKK_CHANNEL_LABEL[r.channel as KvkkChannel] ?? r.channel,
            receivedAt: d(r.received_at)!,
            dueDate: d(r.due_date)!,
            status: r.status,
            statusLabel: KVKK_STATUS_LABEL[r.status as KvkkStatus] ?? r.status,
            note: r.note,
            responseNote: r.response_note,
            closedAt: isoTs(r.closed_at),
            closedByName: r.closed_by_name,
          },
        } satisfies PrintKvkkResponse
        break
      }
      case 'appointment-card': {
        requirePerm(req, 'appointments.read')
        const [r] = await q(
          `select ap.starts_at, ap.ends_at, ap.reason, ap.status, u.full_name as vet_name, ty.name as type_name,
                  coalesce(a.name, ap.animal_name) as animal_name,
                  coalesce(ow.first_name || ' ' || ow.last_name, ap.owner_name) as owner_name
             from appointments ap
             left join users u on u.id = ap.vet_id
             left join appointment_types ty on ty.id = ap.type_id
             left join animals a on a.id = ap.animal_id
             left join owners ow on ow.id = ap.owner_id
            where ap.id = $1`,
          [needId(id, 'Randevu')],
        )
        if (!r) throw new AppError(404, 'Randevu bulunamadı.', 'NOT_FOUND')
        data = {
          startsAt: isoTs(r.starts_at)!,
          endsAt: isoTs(r.ends_at)!,
          vetName: r.vet_name,
          typeName: r.type_name,
          reason: r.reason,
          animalName: r.animal_name,
          ownerName: r.owner_name,
          statusLabel: APPOINTMENT_STATUS_LABEL[r.status as AppointmentStatus] ?? r.status,
        } satisfies PrintAppointmentCard
        break
      }
      case 'worklist':
        data = await printWorklist(req, query)
        break
      case 'report': {
        // Rapor çıktısı ([Yazdır]) - dışa aktarma izni gerekir
        const u = requirePerm(req, 'reports.view', 'reports.export')
        if (!id) throw new AppError(400, 'Rapor belirtilmedi.', 'VALIDATION')
        const r = await runReport(u, id, query)
        await writeAudit(db, { userId: u.id, action: 'export', entity: 'report', entityId: id, summary: `${r.title} raporu yazdırıldı (${formatDateTr(r.from)}-${formatDateTr(r.to)})` })
        data = r
        break
      }
      default:
        throw new AppError(404, 'Bilinmeyen çıktı türü.', 'NOT_FOUND')
    }
    return { kind, clinic: await clinicInfo(), generatedAt: (deps.now?.() ?? new Date()).toISOString(), today: today(), data }
  }

  app.get('/api/print/:kind', printHandler)
  app.get('/api/print/:kind/:id', printHandler)
}
