// Yazdırma çıktıları Ç-01…Ç-09 (SAYFALAR §14). Veri: GET /api/print/:kind/:id? (tek uç).
// Görsel dil: sade, siyah-beyaz baskıya uygun; tek vurgu rengi yok, ince çizgiler.
import type { ReactNode } from 'react'
import { formatChip } from '@shared/chip'
import { formatDateTr } from '@shared/petvet'
import { fmtNum } from '@shared/reports'
import type {
  PrintAnimal,
  PrintAppointmentCard,
  PrintAuditPack,
  PrintChipCard,
  PrintClinic,
  PrintKvkkConsent,
  PrintKvkkResponse,
  PrintOwner,
  PrintVaccineCard,
  PrintVisit,
  PrintWorklist,
  ReportResult,
} from '@shared/reports'
import { Barcode } from './Barcode'
import { BarChart, ReportSummary, ReportTableView, cellText } from './ReportView'

export const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' })
const fmtWeekday = (iso: string) => new Date(iso).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const clinicAddress = (c: PrintClinic) => [c.address, [c.district, c.city].filter(Boolean).join(' / ')].filter(Boolean).join(', ')

// ---------------------------------------------------------------- ortak parçalar

export function Letterhead({ clinic, title, sub, today }: { clinic: PrintClinic; title: string; sub?: ReactNode; today: string }) {
  return (
    <header className="lh">
      <div>
        <div style={{ fontSize: '13pt', fontWeight: 700 }}>{clinic.name}</div>
        <div className="mut" style={{ fontSize: '8.5pt' }}>{clinicAddress(clinic)}</div>
        {clinic.phone && <div className="mut mono" style={{ fontSize: '8.5pt' }}>Tel: {clinic.phone}</div>}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: '12pt', fontWeight: 600 }}>{title}</div>
        {sub && <div className="mut" style={{ fontSize: '8.5pt' }}>{sub}</div>}
        <div className="mut" style={{ fontSize: '8.5pt' }}>Tarih: {formatDateTr(today)}</div>
      </div>
    </header>
  )
}

function KV({ items, cols = 2 }: { items: [string, ReactNode][]; cols?: number }) {
  return (
    <dl className="kvg" style={{ gridTemplateColumns: `repeat(${cols}, auto minmax(0, 1fr))` }}>
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sec-p">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function Text({ v }: { v: string | null | undefined }) {
  return v ? <p style={{ whiteSpace: 'pre-wrap', margin: '0 0 4px' }}>{v}</p> : <p className="mut" style={{ margin: 0 }}>—</p>
}

function Signatures({ labels }: { labels: { title: string; name?: string | null; sub?: string | null }[] }) {
  return (
    <div className="sigs">
      {labels.map((l) => (
        <div key={l.title} className="sig">
          <div className="mut" style={{ fontSize: '8.5pt' }}>{l.title}</div>
          <div style={{ minHeight: '14mm' }} />
          <div className="sig-line">{l.name ?? 'Ad soyad'}</div>
          {l.sub && <div className="mut" style={{ fontSize: '8pt' }}>{l.sub}</div>}
          <div className="mut" style={{ fontSize: '8pt' }}>İmza · Tarih</div>
        </div>
      ))}
    </div>
  )
}

const chipText = (c: string | null) => (c ? formatChip(c) : 'çipsiz')
const birthText = (a: PrintAnimal) => (a.birthDate ? `${a.birthDateEstimated ? '~' : ''}${formatDateTr(a.birthDate)}` : '')

function AnimalBlock({ a, o, extra = [] }: { a: PrintAnimal; o: PrintOwner | null; extra?: [string, ReactNode][] }) {
  return (
    <div className="two">
      <Section title="Hayvan">
        <KV
          cols={1}
          items={[
            ['Adı', <strong>{a.name}</strong>],
            ['Tür / ırk', [a.speciesLabel, a.breed].filter(Boolean).join(' / ')],
            ['Cinsiyet', `${a.sexLabel}${a.neutered ? ' (kısır)' : ''}`],
            ['Doğum', birthText(a)],
            ['Renk', a.color],
            ['Çip no', <span className="mono">{chipText(a.chipNo)}</span>],
            ['Pasaport', a.passportNo],
            ...extra,
          ]}
        />
      </Section>
      <Section title="Sahip">
        {o ? (
          <KV
            cols={1}
            items={[
              ['Ad soyad', o.fullName],
              ['Telefon', <span className="mono">{o.phone}</span>],
              ['Adres', [o.address, [o.district, o.city].filter(Boolean).join(' / ')].filter(Boolean).join(', ')],
            ]}
          />
        ) : (
          <p className="mut">Sahip kaydı yok.</p>
        )}
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- Ç-01 Aşı karnesi

export function VaccineCardDoc({ d, clinic, today }: { d: PrintVaccineCard; clinic: PrintClinic; today: string }) {
  return (
    <>
      <Letterhead clinic={clinic} title="Aşı karnesi" sub={d.animal.name} today={today} />
      <AnimalBlock a={d.animal} o={d.owner} />
      <Section title="Uygulanan aşılar">
        <table className="pt">
          <thead>
            <tr>
              <th>Tarih</th><th>Aşı</th><th>Ürün</th><th>Lot</th><th>Doz</th><th>Hekim</th><th style={{ width: '26mm' }}>İmza / kaşe</th>
            </tr>
          </thead>
          <tbody>
            {d.vaccinations.map((v, i) => (
              <tr key={i} style={{ height: '10mm' }}>
                <td className="mono">{formatDateTr(v.givenAt)}</td>
                <td>{v.kindLabel}</td>
                <td>{v.product}</td>
                <td className="mono">{v.lotNo}</td>
                <td>{v.doseLabel}</td>
                <td>{v.external ? `Dış kayıt${v.externalClinic ? ': ' + v.externalClinic : ''}` : v.vetName}</td>
                <td />
              </tr>
            ))}
            {/* Elle doldurmak için boş satırlar */}
            {Array.from({ length: Math.max(3, 8 - d.vaccinations.length) }).map((_, i) => (
              <tr key={'e' + i} style={{ height: '10mm' }}>
                <td /><td /><td /><td /><td /><td /><td />
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Sonraki aşılar">
        {d.upcoming.length ? (
          <table className="pt">
            <thead><tr><th>Vade</th><th>Aşı</th><th>Doz</th></tr></thead>
            <tbody>
              {d.upcoming.map((u, i) => (
                <tr key={i}><td className="mono">{formatDateTr(u.dueDate)}</td><td>{u.kindLabel}</td><td>{u.doseLabel}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mut">Planlanmış aşı yok.</p>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Ç-02 Kayıt / çip kartı (85,6 × 54 mm, ön + arka)

export function ChipCardDoc({ d, clinic }: { d: PrintChipCard; clinic: PrintClinic }) {
  const a = d.animal
  return (
    <div className="cards">
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5mm' }}>
            <svg width="9" height="10" viewBox="0 0 16 18" aria-hidden="true"><path d="M3 1h10l2 3v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V4z" fill="#A0661A" /><circle cx="8" cy="5" r="1.6" fill="#fff" /></svg>
            <span className="mut" style={{ fontSize: '6pt', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Hayvan kimlik kartı</span>
          </div>
          <span className="mut" style={{ fontSize: '6pt', maxWidth: '35mm', textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{clinic.name}</span>
        </div>
        <div style={{ display: 'flex', gap: '3mm', marginTop: '2mm' }}>
          <div className="photo-box">fotoğraf</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4mm', minWidth: 0 }}>
            <span style={{ fontSize: '13pt', fontWeight: 700, lineHeight: 1.1 }}>{a.name}</span>
            <span style={{ fontSize: '7pt' }}>{[a.speciesLabel, a.breed].filter(Boolean).join(' · ')}</span>
            <span style={{ fontSize: '7pt' }}>{[a.sexLabel, a.color, a.birthDate ? birthText(a) : null].filter(Boolean).join(' · ')}</span>
            <span className="mut" style={{ fontSize: '5.5pt', marginTop: '1.2mm' }}>ÇİP NO</span>
            <span className="mono" style={{ fontSize: '9pt', fontWeight: 600, letterSpacing: '0.03em' }}>{chipText(a.chipNo)}</span>
          </div>
        </div>
        <div style={{ marginTop: 'auto' }}>{a.chipNo && <Barcode value={a.chipNo} height={22} label="Çip numarası barkodu (Code 128)" />}</div>
      </div>
      <div className="card" style={{ background: '#FBFAF7' }}>
        <span style={{ fontSize: '10pt', fontWeight: 700 }}>Beni bulursanız</span>
        <span style={{ fontSize: '7pt', marginTop: '1mm', lineHeight: 1.45 }}>
          Lütfen en yakın veteriner kliniğinde çipimi okutun ya da aşağıdaki numarayı arayın. Sahibimin bilgileri klinikte kayıtlıdır.
        </span>
        <div style={{ marginTop: '2.5mm', display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '0.6mm 2.5mm', fontSize: '7pt' }}>
          <span className="mut">Klinik</span><span style={{ fontWeight: 600 }}>{clinic.name}</span>
          <span className="mut">Telefon</span><span className="mono" style={{ fontWeight: 600 }}>{clinic.phone || '—'}</span>
          <span className="mut">Adres</span><span>{clinicAddress(clinic) || '—'}</span>
          {d.showOwner && d.owner && (
            <>
              <span className="mut">Sahibi</span>
              <span>{d.owner.fullName}{d.owner.phone && <> · <span className="mono">{d.owner.phone}</span></>}</span>
            </>
          )}
        </div>
        <div className="mut" style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', fontSize: '5.5pt' }}>
          <span>Kayıt: {formatDateTr(a.chipImplantedAt)}{a.chipVetName ? ` · ${a.chipVetName}` : ''}</span>
          <span>PatiKünye</span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Ç-03 Muayene özeti / Ç-04 Tedavi talimatı

function VisitHeader({ d }: { d: PrintVisit }) {
  const v = d.visit
  return (
    <>
      <AnimalBlock a={d.animal} o={d.owner} />
      <Section title="Muayene">
        <KV
          cols={2}
          items={[
            ['Tarih', fmtDateTime(v.visitAt)],
            ['Tür', v.typeLabel],
            ['Hekim', v.vetName],
            ['Durum', v.status === 'signed' ? `İmzalı${v.version > 1 ? ` (v${v.version})` : ''} · ${fmtDateTime(v.signedAt)}` : 'TASLAK — imzalanmamış'],
          ]}
        />
      </Section>
    </>
  )
}

export function VisitDoc({ d, clinic, today }: { d: PrintVisit; clinic: PrintClinic; today: string }) {
  const v = d.visit
  return (
    <>
      <Letterhead clinic={clinic} title="Muayene özeti" sub={d.full ? 'Tam sürüm — klinik içi kullanım' : 'Hasta sahibi sürümü'} today={today} />
      <VisitHeader d={d} />
      <Section title="Şikayet / öykü"><Text v={v.subjective} /></Section>
      <Section title="Bulgular">
        {v.vitals.length > 0 && <p style={{ margin: '0 0 4px' }}>{v.vitals.map((x) => `${x.label}: ${x.value}`).join(' · ')}</p>}
        {v.systems.length > 0 ? (
          <table className="pt">
            <tbody>
              {v.systems.map((s) => (
                <tr key={s.label}><td style={{ width: '40mm' }}>{s.label}</td><td style={{ width: '22mm' }}>{s.status}</td><td>{s.note}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          !v.vitals.length && <p className="mut" style={{ margin: 0 }}>—</p>
        )}
      </Section>
      <Section title="Değerlendirme"><Text v={v.assessment} /></Section>
      <Section title="Tanı">
        <Text v={v.diagnoses.join(', ')} />
        {d.full && v.differential.length > 0 && <p className="mut" style={{ margin: 0 }}>Ayırıcı tanı: {v.differential.join(', ')}</p>}
      </Section>
      {(v.planText || v.tests) && (
        <Section title="Plan ve tetkikler">
          <Text v={v.planText} />
          {v.tests && <p style={{ margin: 0 }}>Tetkikler: {v.tests}</p>}
        </Section>
      )}
      {d.treatments.length > 0 && (
        <Section title="Tedaviler">
          <TreatmentTable rows={d.treatments} showKind />
        </Section>
      )}
      <Section title="Sahibe öneriler"><Text v={v.ownerAdvice} /></Section>
      {v.controlDate && <p><strong>Kontrol tarihi:</strong> {formatDateTr(v.controlDate)}</p>}
      {d.full && (
        <Section title="İç not (sahip sürümünde basılmaz)">
          <Text v={v.internalNote} />
          {v.amendReason && <p className="mut">Düzeltme nedeni: {v.amendReason}</p>}
        </Section>
      )}
      <Signatures labels={[{ title: 'Veteriner hekim', name: v.vetName, sub: v.vetRegNo ? `Oda sicil no: ${v.vetRegNo}` : null }]} />
    </>
  )
}

function TreatmentTable({ rows, showKind }: { rows: PrintVisit['treatments']; showKind?: boolean }) {
  return (
    <table className="pt">
      <thead>
        <tr>
          <th>İlaç / ürün</th><th>Doz</th><th>Yol</th><th>Sıklık</th><th>Süre</th>{showKind && <th>Durum</th>}<th>Not</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t, i) => (
          <tr key={i}>
            <td><strong>{t.drug}</strong>{t.activeIngredient && <div className="mut" style={{ fontSize: '8pt' }}>{t.activeIngredient}</div>}</td>
            <td className="mono">{t.dose}</td>
            <td>{t.route}</td>
            <td>{t.frequency}</td>
            <td>{t.duration}</td>
            {showKind && <td>{t.kind === 'administered' ? 'Klinikte uygulandı' : 'Reçete edildi'}</td>}
            <td>{t.note}{t.eReceteNo && <div className="mono" style={{ fontSize: '8pt' }}>e-reçete: {t.eReceteNo}</div>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function PrescriptionDoc({ d, clinic, today }: { d: PrintVisit; clinic: PrintClinic; today: string }) {
  const home = d.treatments.filter((t) => t.kind === 'prescribed')
  const given = d.treatments.filter((t) => t.kind === 'administered')
  return (
    <>
      <Letterhead clinic={clinic} title="Tedavi talimatı" sub={`${d.animal.name} · ${fmtDateTime(d.visit.visitAt)}`} today={today} />
      <div className="note-box">
        <strong>Bu belge resmî e-reçete değildir.</strong> Hekiminizin önerdiği ilaçların kullanım talimatıdır. Reçeteye tabi ilaçlar için e-reçete ayrıca düzenlenir.
      </div>
      <AnimalBlock a={d.animal} o={d.owner} />
      <Section title="Evde kullanılacak ilaçlar">
        {home.length ? <TreatmentTable rows={home} /> : <p className="mut">Evde kullanılacak ilaç yazılmadı.</p>}
      </Section>
      {given.length > 0 && (
        <Section title="Klinikte uygulananlar (bilgi için)">
          <TreatmentTable rows={given} />
        </Section>
      )}
      <Section title="Öneriler"><Text v={d.visit.ownerAdvice} /></Section>
      {d.visit.controlDate && <p><strong>Kontrol tarihi:</strong> {formatDateTr(d.visit.controlDate)}</p>}
      <p className="mut" style={{ fontSize: '8.5pt' }}>İlaçları önerilen doz ve sürede kullanınız. Beklenmeyen bir durumda kliniği arayınız{clinic.phone ? `: ${clinic.phone}` : '.'}</p>
      <Signatures labels={[{ title: 'Veteriner hekim', name: d.visit.vetName, sub: d.visit.vetRegNo ? `Oda sicil no: ${d.visit.vetRegNo}` : null }]} />
    </>
  )
}

// ---------------------------------------------------------------- Ç-05 Aydınlatma metni + çip onam formu

export function KvkkConsentDoc({ d, clinic, today }: { d: PrintKvkkConsent; clinic: PrintClinic; today: string }) {
  const a = d.animal
  return (
    <>
      <Letterhead clinic={clinic} title="Aydınlatma metni ve onam formu" today={today} />
      <div className="two">
        <Section title="Hayvan sahibi">
          <KV
            cols={1}
            items={[
              ['Ad soyad', d.owner.fullName],
              ['T.C. kimlik no', <span className="mono">{d.owner.tcknMasked || '—'}</span>],
              ['Telefon', <span className="mono">{d.owner.phone}</span>],
              ['Adres', [d.owner.address, [d.owner.district, d.owner.city].filter(Boolean).join(' / ')].filter(Boolean).join(', ')],
            ]}
          />
        </Section>
        <Section title="Hayvan">
          {a ? (
            <KV
              cols={1}
              items={[
                ['Adı', a.name],
                ['Tür / ırk', [a.speciesLabel, a.breed].filter(Boolean).join(' / ')],
                ['Cinsiyet / renk', [a.sexLabel, a.color].filter(Boolean).join(' / ')],
                ['Çip no', <span className="mono">{chipText(a.chipNo)}</span>],
              ]}
            />
          ) : (
            <p className="mut">Hayvan seçilmedi.</p>
          )}
        </Section>
      </div>
      <Section title={`Aydınlatma metni${d.notice ? ` (sürüm ${d.notice.version})` : ''}`}>
        <div className="legal">{d.notice?.body ?? 'Etkin aydınlatma metni yok (Ayarlar → KVKK).'}</div>
      </Section>
      {d.consent && (
        <Section title={`Açık rıza (sürüm ${d.consent.version})`}>
          <div className="legal">{d.consent.body}</div>
        </Section>
      )}
      {/* ⚠️ Onam cümlesi örnek metindir; hukukçu/pilot hekim onayıyla düzenlenecek */}
      <Section title="Mikroçip uygulama onamı">
        <p className="legal" style={{ margin: 0 }}>
          Yukarıda bilgileri yer alan hayvanıma mikroçip uygulanmasına ve kimlik bilgilerinin evcil hayvan kayıt sistemine (PETVET) kaydedilmesine onay
          veriyorum. Uygulama hakkında hekim tarafından bilgilendirildim.
        </p>
      </Section>
      <Signatures labels={[{ title: 'Hayvan sahibi', name: d.owner.fullName }, { title: 'Veteriner hekim' }]} />
    </>
  )
}

// ---------------------------------------------------------------- Ç-06 PETVET denetim paketi (S-62)

export function AuditPackDoc({ d, clinic, today }: { d: PrintAuditPack; clinic: PrintClinic; today: string }) {
  const range = `${formatDateTr(d.from)} – ${formatDateTr(d.to)}`
  return (
    <>
      <div className="cover">
        <div style={{ fontSize: '10pt' }} className="mut">{clinic.name}</div>
        <h1 style={{ fontSize: '22pt', margin: '6mm 0 2mm' }}>PETVET Denetim Paketi</h1>
        <div style={{ fontSize: '13pt' }}>{range}</div>
        <div style={{ marginTop: '12mm' }}>
          <KV
            cols={1}
            items={[
              ['Klinik', clinic.name],
              ['Adres', clinicAddress(clinic)],
              ['Telefon', clinic.phone],
              ['Hekim', d.vetName ?? 'Tüm hekimler'],
              ['Görev türleri', d.kinds.length ? d.kinds.join(', ') : 'Tümü'],
              ['Kapsam', d.doneOnly ? 'Yalnızca girilen (tamamlanan) görevler' : 'İptal edilenler hariç tüm görevler'],
              ['Görev sayısı', fmtNum(d.rows.length)],
              ['Oluşturma', formatDateTr(today)],
            ]}
          />
        </div>
        <p className="mut" style={{ marginTop: '12mm', fontSize: '8.5pt' }}>
          Sahip T.C. kimlik numaraları maskelenmiştir. Gün farkı = PETVET giriş tarihi − olay (uygulama) tarihi. Gecikme = giriş tarihi − son tarih (0 ve altı: süresinde).
        </p>
      </div>
      <Letterhead clinic={clinic} title="PETVET denetim paketi" sub={range} today={today} />
      <Section title="Özet">
        <table className="pt">
          <thead>
            <tr><th>İş türü</th><th className="r">Görev</th><th className="r">Girildi</th><th className="r">Süresinde</th><th className="r">Gecikmeli</th><th className="r">Açık</th></tr>
          </thead>
          <tbody>
            {d.summary.map((s) => (
              <tr key={s.kindLabel}>
                <td>{s.kindLabel}</td><td className="r mono">{s.total}</td><td className="r mono">{s.done}</td><td className="r mono">{s.onTime}</td><td className="r mono">{s.late}</td><td className="r mono">{s.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Görev listesi">
        <table className="pt small">
          <thead>
            <tr>
              <th>#</th><th>İş</th><th>Çip no</th><th>Hayvan</th><th>Sahip (TCKN maskeli)</th><th>Uygulama</th><th>Son tarih</th><th>PETVET giriş</th><th className="r">Gün farkı</th><th className="r">Gecikme</th><th>Referans no</th><th>Ek</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i}>
                <td className="mono">{i + 1}</td>
                <td>{r.kindLabel}</td>
                <td className="mono">{r.chipNo ? formatChip(r.chipNo) : '—'}</td>
                <td>{r.animalName} <span className="mut">({r.speciesLabel})</span></td>
                <td>{r.ownerName ?? '—'}{r.tcknMasked && <div className="mono mut">{r.tcknMasked}</div>}</td>
                <td className="mono">{formatDateTr(r.eventDate)}</td>
                <td className="mono">{formatDateTr(r.dueDate)}</td>
                <td className="mono">{r.doneDate ? formatDateTr(r.doneDate) : r.statusLabel}</td>
                <td className="r mono">{r.daysToEntry ?? '—'}</td>
                <td className="r mono">{r.lateDays == null ? '—' : r.lateDays > 0 ? `+${r.lateDays}` : '0'}</td>
                <td className="mono">{r.petvetRef ?? ''}</td>
                <td className="mono">{r.attachments.length || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.rows.length === 0 && <p className="mut">Bu aralıkta görev yok.</p>}
      </Section>
      <Section title="Belge ekleri">
        {d.attachments.length ? (
          <table className="pt small">
            <thead><tr><th>Görev</th><th>Dosya</th><th className="r">Boyut</th><th>Yüklenme</th></tr></thead>
            <tbody>
              {d.attachments.map((a, i) => (
                <tr key={i}><td>{a.taskLabel}</td><td>{a.fileName}</td><td className="r mono">{fmtNum(Math.ceil(a.size / 1024))} KB</td><td className="mono">{fmtDateTime(a.createdAt)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mut">Yüklenmiş belge yok.</p>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Ç-07 KVKK talep yanıtı (S-95)

export function KvkkResponseDoc({ d, clinic, today }: { d: PrintKvkkResponse; clinic: PrintClinic; today: string }) {
  const r = d.request
  const addr = [d.owner.address, [d.owner.district, d.owner.city].filter(Boolean).join(' / ')].filter(Boolean).join(', ')
  return (
    <>
      <Letterhead clinic={clinic} title="KVKK başvuru yanıtı" today={today} />
      {/* ⚠️ Yanıt yazısı örnek şablondur; hukukçu onayıyla düzenlenecek */}
      <div style={{ marginTop: '8mm', lineHeight: 1.6 }}>
        <p style={{ margin: 0 }}>Sayın <strong>{d.owner.fullName}</strong></p>
        {addr && <p className="mut" style={{ margin: 0 }}>{addr}</p>}
        <p style={{ margin: '6mm 0 4mm' }}><strong>Konu:</strong> Kişisel verilerinize ilişkin başvurunuz hk.</p>
        <p>
          {formatDateTr(r.receivedAt)} tarihinde {r.channelLabel.toLocaleLowerCase('tr-TR')} yoluyla tarafımıza ilettiğiniz <strong>{r.typeLabel.toLocaleLowerCase('tr-TR')}</strong>{' '}
          talebiniz, 6698 sayılı Kişisel Verilerin Korunması Kanunu kapsamında incelenmiştir.
        </p>
        <div className="legal" style={{ margin: '4mm 0' }}>{r.responseNote || '[Yanıt metni]'}</div>
        <p>Bilgilerinize sunarız.</p>
      </div>
      <KV
        cols={2}
        items={[
          ['Başvuru no', <span className="mono">{r.id.slice(0, 8).toUpperCase()}</span>],
          ['Başvuru tarihi', formatDateTr(r.receivedAt)],
          ['Talep türü', r.typeLabel],
          ['Durum', r.statusLabel],
          ['Yasal son tarih', formatDateTr(r.dueDate)],
          ['Yanıt tarihi', r.closedAt ? formatDateTr(r.closedAt.slice(0, 10)) : formatDateTr(today)],
        ]}
      />
      <Signatures labels={[{ title: 'Veri sorumlusu', name: clinic.name, sub: r.closedByName ? `Yetkili: ${r.closedByName}` : null }]} />
    </>
  )
}

// ---------------------------------------------------------------- Ç-08 Randevu kartı

export function AppointmentCardDoc({ d, clinic }: { d: PrintAppointmentCard; clinic: PrintClinic }) {
  return (
    <div className="cards">
      <div className="card">
        <div className="mut" style={{ fontSize: '6pt', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Randevu kartı · {clinic.name}</div>
        <div style={{ fontSize: '11pt', fontWeight: 700, marginTop: '2mm' }}>{fmtWeekday(d.startsAt)}</div>
        <div className="mono" style={{ fontSize: '16pt', fontWeight: 600 }}>{fmtTime(d.startsAt)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '0.5mm 2.5mm', fontSize: '7pt', marginTop: '1.5mm' }}>
          <span className="mut">Hasta</span><span>{d.animalName ?? '—'}{d.ownerName ? ` · ${d.ownerName}` : ''}</span>
          <span className="mut">Hekim</span><span>{d.vetName ?? '—'}</span>
          {d.typeName && <><span className="mut">Tür</span><span>{d.typeName}</span></>}
          <span className="mut">Adres</span><span>{clinicAddress(clinic) || '—'}</span>
          <span className="mut">Telefon</span><span className="mono">{clinic.phone || '—'}</span>
        </div>
        <div className="mut" style={{ marginTop: 'auto', fontSize: '6pt' }}>Gelemeyecekseniz lütfen önceden haber verin.</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Ç-09 İş listeleri

export function WorklistDoc({ d, clinic, today }: { d: PrintWorklist; clinic: PrintClinic; today: string }) {
  return (
    <>
      <Letterhead clinic={clinic} title={d.list === 'petvet' ? 'PETVET iş listesi' : 'Aşı arama listesi'} sub={`${d.rows.length} satır`} today={today} />
      <h2 style={{ fontSize: '10pt', margin: '4mm 0 2mm' }}>{d.title}</h2>
      <table className="pt small">
        <thead>
          <tr>
            {d.columns.map((c) => <th key={c.key} className={c.num ? 'r' : undefined}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r, i) => (
            <tr key={i} style={{ height: '8mm' }}>
              {d.columns.map((c) => (
                <td key={c.key} className={[c.num ? 'r' : '', c.mono || c.num ? 'mono' : ''].join(' ').trim() || undefined}>
                  {c.key === 'chipNo' && typeof r[c.key] === 'string' && r[c.key] ? formatChip(r[c.key] as string) : cellText(r[c.key] ?? null, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {d.rows.length === 0 && <p className="mut">Listede kayıt yok.</p>}
    </>
  )
}

// ---------------------------------------------------------------- Rapor çıktısı (S-90 [Yazdır])

export function ReportDoc({ d, clinic, today }: { d: ReportResult; clinic: PrintClinic; today: string }) {
  return (
    <>
      <Letterhead
        clinic={clinic}
        title={`${d.title} raporu`}
        sub={`${formatDateTr(d.from)} – ${formatDateTr(d.to)}${d.vetName ? ` · ${d.vetName}` : ''}`}
        today={today}
      />
      <div style={{ margin: '4mm 0' }}><ReportSummary r={d} /></div>
      {d.chart && d.chart.bars.length > 0 && <div style={{ margin: '4mm 0', breakInside: 'avoid' }}><BarChart chart={d.chart} /></div>}
      <div className="rp-print">
        {d.tables.map((t) => <ReportTableView key={t.title} table={t} compact />)}
      </div>
      {d.notes?.map((n) => <p key={n} className="mut" style={{ fontSize: '8pt' }}>{n}</p>)}
    </>
  )
}
