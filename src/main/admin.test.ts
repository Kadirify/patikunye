//  testleri: kullanıcılar, PIN/kilit, zorunlu parola, sözlükler, ayar izinleri, KVKK, denetim zinciri
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestBackend, type TestBackend } from './test-helpers'
import type { AdminUserDto, AnonymizePreview, AuditVerifyDto, DictItem, KvkkRequestDto, LoginResult } from '../shared/admin'
import type { SessionDto } from '../shared/api-types'

let t: TestBackend

beforeAll(async () => {
  t = await startTestBackend()
}, 120_000)
afterAll(async () => {
  await t?.stop()
})

async function createUser(username: string, role: string, extra: Record<string, unknown> = {}) {
  const r = await t.api<{ user: AdminUserDto; tempPassword: string }>('POST', '/api/admin/users', {
    fullName: `test ${username}`,
    username,
    role,
    chamberRegNo: role === 'vet' ? '06-9' : null,
    ...extra,
  })
  expect(r.status).toBe(200)
  return r.data
}

/** Geçici parolayla giriş + zorunlu değişiklik -> oturum */
async function activate(username: string, temp: string, newPassword = 'yeni-parola-123') {
  const l = await t.api<LoginResult>('POST', '/api/auth/login', { username, password: temp }, null)
  expect(l.status).toBe(200)
  expect('mustChangePassword' in l.data).toBe(true)
  const changeToken = (l.data as { changeToken: string }).changeToken
  const r = await t.api<SessionDto>('POST', '/api/auth/first-password', { changeToken, newPassword }, null)
  expect(r.status).toBe(200)
  return r.data
}

describe('kullanıcılar', () => {
  it('kullanıcı oluşturur; geçici parola ile tam oturum verilmez, parola değiştirince açılır', async () => {
    const { user, tempPassword } = await createUser('zehra', 'secretary')
    expect(user.mustChangePassword).toBe(true)
    expect(user.fullName).toBe('Test Zehra')

    const l = await t.api<LoginResult>('POST', '/api/auth/login', { username: 'zehra', password: tempPassword }, null)
    expect(l.status).toBe(200)
    expect('token' in l.data).toBe(false)
    const changeToken = (l.data as { changeToken: string }).changeToken
    // değişiklik anahtarı oturum yerine geçmez
    expect((await t.api('GET', '/api/auth/me', undefined, changeToken)).status).toBe(401)
    // aynı parola reddedilir
    expect((await t.api('POST', '/api/auth/first-password', { changeToken, newPassword: tempPassword }, null)).status).toBe(400)
    const s = await t.api<SessionDto>('POST', '/api/auth/first-password', { changeToken, newPassword: 'zehra-parola-1' }, null)
    expect(s.status).toBe(200)
    expect((await t.api('GET', '/api/auth/me', undefined, s.data.token)).status).toBe(200)
    // sonraki girişte doğrudan oturum
    const l2 = await t.api<LoginResult>('POST', '/api/auth/login', { username: 'zehra', password: 'zehra-parola-1' }, null)
    expect('token' in l2.data).toBe(true)
  })

  it('doğrulama: hekimde oda sicil no zorunlu, aynı kullanıcı adı 409', async () => {
    const r = await t.api('POST', '/api/admin/users', { fullName: 'Can Ertürk', username: 'can', role: 'vet' })
    expect(r.status).toBe(400)
    expect((await t.api('POST', '/api/admin/users', { fullName: 'Başka Zehra', username: 'zehra', role: 'tech' })).status).toBe(409)
  })

  it('sekreter kullanıcı yönetemez (403)', async () => {
    const sec = await t.loginAs('secretary')
    expect((await t.api('GET', '/api/admin/users', undefined, sec.token)).status).toBe(403)
    expect((await t.api('POST', '/api/admin/users', { fullName: 'X Y Z', username: 'xyz', role: 'tech' }, sec.token)).status).toBe(403)
  })

  it('parola sıfırlama: geçici parola + zorunlu değişiklik + oturumlar kapanır', async () => {
    const { user, tempPassword } = await createUser('emre', 'tech')
    const s = await activate('emre', tempPassword)
    const reset = await t.api<{ tempPassword: string }>('POST', `/api/admin/users/${user.id}/reset-password`)
    expect(reset.status).toBe(200)
    expect((await t.api('GET', '/api/auth/me', undefined, s.token)).status).toBe(401)
    expect((await t.api('POST', '/api/auth/login', { username: 'emre', password: 'yeni-parola-123' }, null)).status).toBe(401)
    await activate('emre', reset.data.tempPassword, 'emre-yeni-parola')
  })

  it('devre dışı bırakılan kullanıcı giremez; son yönetici korunur', async () => {
    const { user, tempPassword } = await createUser('gecici', 'tech')
    const s = await activate('gecici', tempPassword)
    const d = await t.api<AdminUserDto>('PATCH', `/api/admin/users/${user.id}`, { active: false })
    expect(d.status).toBe(200)
    expect(d.data.active).toBe(false)
    expect((await t.api('GET', '/api/auth/me', undefined, s.token)).status).toBe(401)
    expect((await t.api('POST', '/api/auth/login', { username: 'gecici', password: 'yeni-parola-123' }, null)).status).toBe(401)

    // tek yönetici: rolü düşürülemez
    const r = await t.api<{ code: string }>('PATCH', `/api/admin/users/${t.adminId}`, { role: 'vet', chamberRegNo: '06-1' })
    expect(r.status).toBe(409)
    expect(r.data.code).toBe('LAST_ADMIN')
    // ikinci yönetici varken ilk yönetici başkası tarafından devre dışı bırakılabilir mi? Önce ikinci yönetici ekle
    const a2 = await createUser('yonetici2', 'admin')
    const s2 = await activate('yonetici2', a2.tempPassword)
    // ikinci yönetici kendini devre dışı bırakamaz
    expect((await t.api('PATCH', `/api/admin/users/${a2.user.id}`, { active: false }, s2.token)).status).toBe(409)
    // ilk yönetici ikinciyi devre dışı bırakabilir (yine bir yönetici kalır)
    expect((await t.api('PATCH', `/api/admin/users/${a2.user.id}`, { active: false })).status).toBe(200)
    // artık tek yönetici yine korunuyor
    expect((await t.api('PATCH', `/api/admin/users/${t.adminId}`, { role: 'secretary' })).status).toBe(409)
  })
})

describe('PIN girişi ve kilit', () => {
  it('PIN izni yoksa PIN belirlenemez ve PIN ile girilemez', async () => {
    const { tempPassword } = await createUser('pinyok', 'secretary')
    const s = await activate('pinyok', tempPassword)
    expect((await t.api('PUT', '/api/auth/pin', { currentPassword: 'yeni-parola-123', pin: '4826' }, s.token)).status).toBe(403)
    expect((await t.api('POST', '/api/auth/pin-login', { username: 'pinyok', pin: '4826' }, null)).status).toBe(403)
  })

  it('PIN ile giriş, kolay PIN reddi, 5 hatalı denemede kilit', async () => {
    const { tempPassword } = await createUser('ayse', 'vet', { pinAllowed: true })
    const s = await activate('ayse', tempPassword)
    expect((await t.api('PUT', '/api/auth/pin', { currentPassword: 'yeni-parola-123', pin: '1234' }, s.token)).status).toBe(400)
    expect((await t.api('PUT', '/api/auth/pin', { currentPassword: 'yanlis', pin: '4826' }, s.token)).status).toBe(400)
    expect((await t.api('PUT', '/api/auth/pin', { currentPassword: 'yeni-parola-123', pin: '4826' }, s.token)).status).toBe(200)

    const cards = await t.api<{ username: string; pinEnabled: boolean }[]>('GET', '/api/login-users', undefined, null)
    expect(cards.data.find((c) => c.username === 'ayse')?.pinEnabled).toBe(true)

    const ok = await t.api<SessionDto>('POST', '/api/auth/pin-login', { username: 'ayse', pin: '4826' }, null)
    expect(ok.status).toBe(200)
    expect(ok.data.token).toBeTruthy()

    // kilit açma: PIN ve parola
    expect((await t.api('POST', '/api/auth/unlock', { pin: '4826' }, ok.data.token)).status).toBe(200)
    expect((await t.api('POST', '/api/auth/unlock', { password: 'yeni-parola-123' }, ok.data.token)).status).toBe(200)
    expect((await t.api('POST', '/api/auth/unlock', { pin: '0000' }, ok.data.token)).status).toBe(400)
    expect((await t.api('POST', '/api/auth/unlock', {}, null)).status).toBe(401)

    for (let i = 0; i < 4; i++) expect((await t.api('POST', '/api/auth/pin-login', { username: 'ayse', pin: '9999' }, null)).status).toBe(401)
    // 5. hatalı deneme (önceki unlock hatası da sayıldı) -> kilit
    const fifth = await t.api('POST', '/api/auth/pin-login', { username: 'ayse', pin: '9999' }, null)
    expect([401, 429]).toContain(fifth.status)
    const locked = await t.api<{ code: string }>('POST', '/api/auth/pin-login', { username: 'ayse', pin: '4826' }, null)
    expect(locked.status).toBe(429)
    // parola ile de kilitli
    expect((await t.api('POST', '/api/auth/login', { username: 'ayse', password: 'yeni-parola-123' }, null)).status).toBe(429)

    const audit = await t.backend.db.$client.query(`select count(*)::int as n from audit_logs where action = 'login_failed' and summary like 'ayse%'`)
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(4)
  })

  it('parola değiştirme: mevcut parola kontrolü ve diğer oturumların kapanması', async () => {
    const { tempPassword } = await createUser('degis', 'tech')
    const s1 = await activate('degis', tempPassword)
    const l2 = await t.api<SessionDto>('POST', '/api/auth/login', { username: 'degis', password: 'yeni-parola-123' }, null)
    expect((await t.api('POST', '/api/auth/change-password', { currentPassword: 'yanlis', newPassword: 'cok-yeni-parola' }, s1.token)).status).toBe(400)
    expect((await t.api('POST', '/api/auth/change-password', { currentPassword: 'yeni-parola-123', newPassword: 'kisa' }, s1.token)).status).toBe(400)
    expect((await t.api('POST', '/api/auth/change-password', { currentPassword: 'yeni-parola-123', newPassword: 'cok-yeni-parola' }, s1.token)).status).toBe(200)
    expect((await t.api('GET', '/api/auth/me', undefined, s1.token)).status).toBe(200)
    expect((await t.api('GET', '/api/auth/me', undefined, l2.data.token)).status).toBe(401)
  })
})

describe('sözlükler ve ayarlar', () => {
  it('sözlük okuma (tür filtresi), ekleme, CSV içe/dışa aktarma', async () => {
    const tech = await t.loginAs('tech')
    const cat = await t.api<DictItem[]>('GET', '/api/dictionaries/breed?species=cat', undefined, tech.token)
    expect(cat.status).toBe(200)
    expect(cat.data.some((d) => d.value === 'Van Kedisi')).toBe(true)
    expect(cat.data.some((d) => d.value === 'Kangal')).toBe(false)
    const colors = await t.api<DictItem[]>('GET', '/api/dictionaries/color', undefined, tech.token)
    expect(colors.data.length).toBeGreaterThan(5)
    expect((await t.api('GET', '/api/dictionaries/foo')).status).toBe(400)
    expect((await t.api('GET', '/api/dictionaries/color', undefined, null)).status).toBe(401)

    // düzenleme izni
    expect((await t.api('POST', '/api/dictionaries/color', { value: 'Lila' }, tech.token)).status).toBe(403)
    expect((await t.api('POST', '/api/dictionaries/color', { value: 'Lila' })).status).toBe(200)
    expect((await t.api('POST', '/api/dictionaries/color', { value: 'lila' })).status).toBe(409)
    expect((await t.api('POST', '/api/dictionaries/breed', { value: 'Tazı' })).status).toBe(400)

    const imp = await t.api<{ added: number; updated: number }>('POST', '/api/dictionaries/breed/import', {
      csv: 'tur,deger,sira,aktif\ndog,Saluki,50,1\ndog,"Kangal",1,0\n',
    })
    expect(imp.status).toBe(200)
    expect(imp.data).toEqual({ added: 1, updated: 1 })
    const dogs = await t.api<DictItem[]>('GET', '/api/dictionaries/breed?species=dog')
    expect(dogs.data.some((d) => d.value === 'Saluki')).toBe(true)
    expect(dogs.data.some((d) => d.value === 'Kangal')).toBe(false) // pasif
    const bad = await t.api('POST', '/api/dictionaries/breed/import', { csv: 'tur,deger\n,Tazı\n' })
    expect(bad.status).toBe(400)
    const csv = await t.api<string>('GET', '/api/dictionaries/breed/csv')
    expect(csv.status).toBe(200)
    expect(csv.data).toContain('dog,Saluki,50,1')
  })

  it('ayar güncelleme: sekreter 403, yönetici günceller ve denetime yazılır', async () => {
    const sec = await t.loginAs('secretary')
    expect((await t.api('PATCH', '/api/admin/settings', { reader: { mode: 'keyboard', maxGapMs: 50 } }, sec.token)).status).toBe(403)
    expect((await t.api('PUT', '/api/admin/clinic', { name: 'X Klinik', city: 'Ankara', district: 'Çankaya' }, sec.token)).status).toBe(403)
    expect((await t.api('PATCH', '/api/admin/settings', { reader: { mode: 'keyboard', maxGapMs: 1 } })).status).toBe(400)
    expect((await t.api('PATCH', '/api/admin/settings', { bilinmeyen: 1 })).status).toBe(400)
    const r = await t.api<{ reader: { maxGapMs: number }; security: { showUserCards: boolean } }>('PATCH', '/api/admin/settings', {
      reader: { mode: 'keyboard', maxGapMs: 50 },
      security: { lockMinutes: 15, showUserCards: false },
    })
    expect(r.status).toBe(200)
    expect(r.data.reader.maxGapMs).toBe(50)
    // kartlar gizli -> giriş ekranı listesi boş
    expect((await t.api<unknown[]>('GET', '/api/login-users', undefined, null)).data).toEqual([])
    await t.api('PATCH', '/api/admin/settings', { security: { lockMinutes: 15, showUserCards: true } })
    const s = await t.api<{ reader: { maxGapMs: number } }>('GET', '/api/admin/settings', undefined, sec.token)
    expect(s.data.reader.maxGapMs).toBe(50)
    const c = await t.api('PUT', '/api/admin/clinic', { name: 'Test Kliniği', city: 'Ankara', district: 'Çankaya', address: 'Atatürk Blv. 1' })
    expect(c.status).toBe(200)
  })

  it('KVKK metni yeni sürüm yayımlar', async () => {
    const before = await t.api<{ kind: string; version: number; body: string }[]>('GET', '/api/kvkk/texts')
    const notice = before.data.find((x) => x.kind === 'notice')!
    expect(notice.version).toBe(1)
    expect(notice.body).toContain('ORNEK SABLON')
    const r = await t.api<{ version: number }>('POST', '/api/kvkk/texts', { kind: 'notice', body: notice.body + '\nEk paragraf.' })
    expect(r.data.version).toBe(2)
    expect((await t.api('POST', '/api/kvkk/texts', { kind: 'notice', body: notice.body + '\nEk paragraf.' })).status).toBe(400)
  })
})

describe('KVKK talepleri', () => {
  it('talep, veri kopyası ve anonimleştirme', async () => {
    const reg = await t.registerAnimal({ ownerTckn: '10000000146', phone: '05321234567', name: 'Boncuk' })
    const ownerId = reg.ownerId

    const vet = await t.loginAs('vet')
    expect((await t.api('GET', '/api/kvkk/requests', undefined, vet.token)).status).toBe(403)

    const req = await t.api<KvkkRequestDto>('POST', '/api/kvkk/requests', { ownerId, type: 'erase', receivedAt: '2026-10-20', channel: 'written' })
    expect(req.status).toBe(200)
    expect(req.data.dueDate).toBe('2026-11-19')
    expect(req.data.daysLeft).toBe(23)
    expect((await t.api('POST', '/api/kvkk/requests', { ownerId, type: 'erase', receivedAt: '2027-01-01', channel: 'written' })).status).toBe(400)

    // veri kopyası
    const exp = await t.api<{ owner: { tckn: string; phone: string; tckn_enc?: string }; animals: { name: string }[]; related: Record<string, unknown[]> }>(
      'GET',
      `/api/kvkk/owners/${ownerId}/export?requestId=${req.data.id}`,
    )
    expect(exp.status).toBe(200)
    expect(exp.data.owner.tckn).toBe('10000000146')
    expect(exp.data.owner.tckn_enc).toBeUndefined()
    expect(exp.data.animals[0].name).toBe('Boncuk')
    expect(exp.data.related.microchips?.length).toBe(1)
    const ea = await t.backend.db.$client.query(`select count(*)::int as n from audit_logs where action = 'export' and entity_id = $1`, [ownerId])
    expect(ea.rows[0].n).toBe(1)

    // önizleme
    const pv = await t.api<AnonymizePreview>('GET', `/api/kvkk/owners/${ownerId}/anonymize-preview`)
    expect(pv.data.anonymName).toMatch(/^Anonim Sahip #[0-9A-F]{4}$/)
    expect(pv.data.clearedFields.find((f) => f.field === 'phone')?.hasValue).toBe(true)
    expect(pv.data.kept.find((k) => k.label === 'Mikroçip kayıtları')?.count).toBe(1)

    // onay kuralları
    expect((await t.api('POST', `/api/kvkk/owners/${ownerId}/anonymize`, { confirm: 'evet', password: 'test-parola-123' })).status).toBe(400)
    expect((await t.api('POST', `/api/kvkk/owners/${ownerId}/anonymize`, { confirm: 'ANONİMLEŞTİR', password: 'yanlis' })).status).toBe(403)

    const an = await t.api<{ anonymName: string }>('POST', `/api/kvkk/owners/${ownerId}/anonymize`, {
      confirm: 'ANONİMLEŞTİR',
      password: 'test-parola-123',
      requestId: req.data.id,
    })
    expect(an.status).toBe(200)
    expect(an.data.anonymName).toBe(pv.data.anonymName)

    const o = await t.backend.db.$client.query('select * from owners where id = $1', [ownerId])
    const row = o.rows[0]
    expect(row.first_name).toBe('Anonim')
    expect(row.tckn_enc).toBeNull()
    expect(row.tckn_hash).toBeNull()
    expect(row.tckn_last4).toBeNull()
    expect(row.phone).toBeNull()
    expect(row.anonymized_at).not.toBeNull()
    // hayvan ve çip kalır, sahip bağlantısı korunur
    const a = await t.backend.db.$client.query('select a.name from animals a join animal_owners ao on ao.animal_id = a.id where ao.owner_id = $1', [ownerId])
    expect(a.rows[0].name).toBe('Boncuk')
    const chip = await t.backend.db.$client.query('select count(*)::int as n from microchips where animal_id = $1', [reg.animalId])
    expect(chip.rows[0].n).toBe(1)
    // talep kapandı, audit yazıldı, ikinci kez yapılamaz
    const rq = await t.api<KvkkRequestDto>('GET', `/api/kvkk/requests/${req.data.id}`)
    expect(rq.data.status).toBe('done')
    expect(rq.data.ownerAnonymized).toBe(true)
    const au = await t.backend.db.$client.query(`select count(*)::int as n from audit_logs where entity = 'owner' and entity_id = $1 and summary like 'KVKK anonimleştirme%'`, [ownerId])
    expect(au.rows[0].n).toBe(1)
    expect((await t.api('POST', `/api/kvkk/owners/${ownerId}/anonymize`, { confirm: 'ANONİMLEŞTİR', password: 'test-parola-123' })).status).toBe(409)
  })

  it('talep kapatma yanıt notu ister', async () => {
    const reg = await t.registerAnimal()
    const req = await t.api<KvkkRequestDto>('POST', '/api/kvkk/requests', { ownerId: reg.ownerId, type: 'info', receivedAt: '2026-10-27', channel: 'email' })
    expect((await t.api('PATCH', `/api/kvkk/requests/${req.data.id}`, { status: 'done' })).status).toBe(400)
    const r = await t.api<KvkkRequestDto>('PATCH', `/api/kvkk/requests/${req.data.id}`, { status: 'done', responseNote: 'Bilgi verildi.' })
    expect(r.data.status).toBe('done')
    expect(r.data.closedAt).not.toBeNull()
  })
})

describe('denetim kaydı', () => {
  it('liste, filtre, maskeli ayrıntı ve izin', async () => {
    const sec = await t.loginAs('secretary')
    expect((await t.api('GET', '/api/audit', undefined, sec.token)).status).toBe(403)
    const l = await t.api<{ rows: { id: number; action: string; entity: string }[]; total: number }>('GET', '/api/audit?entity=user&action=create')
    expect(l.status).toBe(200)
    expect(l.data.total).toBeGreaterThan(0)
    expect(l.data.rows.every((r) => r.entity === 'user' && r.action === 'create')).toBe(true)
    const settingsRow = await t.api<{ rows: { id: number }[] }>('GET', '/api/audit?entity=settings')
    const d = await t.api<{ diff: unknown }>('GET', `/api/audit/${settingsRow.data.rows[0].id}`)
    expect(d.status).toBe(200)
    expect(d.data.diff).toBeTruthy()
  })

  it('zincir doğrulama: sağlam zincir geçer, elle bozulan satır yakalanır', async () => {
    const ok = await t.api<AuditVerifyDto>('POST', '/api/audit/verify')
    expect(ok.status).toBe(200)
    expect(ok.data.broken).toEqual([])
    expect(ok.data.ok).toBe(true)
    expect(ok.data.checked).toBeGreaterThan(10)

    const victim = await t.backend.db.$client.query(`select id from audit_logs order by id limit 1 offset 5`)
    const id = Number(victim.rows[0].id)
    await t.backend.db.$client.query(`update audit_logs set summary = 'değiştirildi' where id = $1`, [id])
    const bad = await t.api<AuditVerifyDto>('POST', '/api/audit/verify')
    expect(bad.data.ok).toBe(false)
    expect(bad.data.broken.map((b) => b.id)).toContain(id)

    // silinen satır bağlantı kopukluğu olarak yakalanır
    const del = await t.backend.db.$client.query(`select id from audit_logs order by id limit 1 offset 8`)
    const delId = Number(del.rows[0].id)
    await t.backend.db.$client.query(`delete from audit_logs where id = $1`, [delId])
    const bad2 = await t.api<AuditVerifyDto>('POST', '/api/audit/verify')
    expect(bad2.data.broken.some((b) => b.id > delId && b.reason.includes('bağlantı'))).toBe(true)
  })
})
