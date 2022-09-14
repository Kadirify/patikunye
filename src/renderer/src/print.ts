// Yazdırma çıktıları (Ç-01…Ç-09) — Raporlar/yazdırma modülü (H). Önizleme: pages/print/PrintPage.tsx, veri: GET /api/print/:kind/:id?
// Diğer modüller yalnızca openPrint(...) çağırır.
export type PrintKind =
  | 'vaccine-card' // Ç-01 aşı karnesi (id = animalId)
  | 'chip-card' // Ç-02 kayıt/çip kartı (id = animalId)
  | 'visit' // Ç-03 muayene özeti (id = visitId)
  | 'prescription' // Ç-04 tedavi talimatı (id = visitId)
  | 'kvkk-consent' // Ç-05 aydınlatma + onam formu (id = ownerId, params.animalId)
  | 'audit-pack' // Ç-06 denetim paketi (params.from, params.to)
  | 'kvkk-response' // Ç-07 KVKK talep yanıtı (id = requestId)
  | 'appointment-card' // Ç-08 randevu kartı (id = appointmentId)
  | 'worklist' // Ç-09 iş listeleri (params.list = 'petvet' | 'vaccine-calls'; vaccine-calls için params.days)
  | 'report' // S-90 rapor çıktısı (id = rapor anahtarı, params.from/to/vetId/lot)

/**
 * Yazdırma önizlemesini açar (#/yazdir/:kind/:id?params).
 * Ortak parametreler: size = a4 | a5 | card (türe göre), visit için full=1 (iç notlu tam sürüm), chip-card için owner=1.
 */
export function openPrint(kind: PrintKind, id?: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams(params).toString()
  const hash = `#/yazdir/${kind}${id ? '/' + id : ''}${q ? '?' + q : ''}`
  window.open(location.href.split('#')[0] + hash, '_blank', 'width=900,height=1000')
}
