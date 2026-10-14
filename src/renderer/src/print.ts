// Yazdırma ciktilari. Onizleme: pages/print/PrintPage.tsx, veri: GET /api/print/:kind/:id?
// Diger moduller yalnizca openPrint(...) cagirir.
export type PrintKind =
  | 'vaccine-card' // asi karnesi (id = animalId)
  | 'chip-card' // kayit/cip karti (id = animalId)
  | 'visit' // muayene ozeti (id = visitId)
  | 'prescription' // tedavi talimati (id = visitId)
  | 'kvkk-consent' // aydinlatma + onam formu (id = ownerId, params.animalId)
  | 'audit-pack' // denetim paketi (params.from, params.to)
  | 'kvkk-response' // KVKK talep yaniti (id = requestId)
  | 'appointment-card' // randevu karti (id = appointmentId)
  | 'worklist' // is listeleri (params.list = 'petvet' | 'vaccine-calls'; vaccine-calls icin params.days)
  | 'report' // rapor ciktisi (id = rapor anahtari, params.from/to/vetId/lot)

/**
 * Yazdırma önizlemesini açar (#/yazdir/:kind/:id?params).
 * Ortak parametreler: size = a4 | a5 | card (türe göre), visit için full=1 (iç notlu tam sürüm), chip-card için owner=1.
 */
export function openPrint(kind: PrintKind, id?: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams(params).toString()
  const hash = `#/yazdir/${kind}${id ? '/' + id : ''}${q ? '?' + q : ''}`
  window.open(location.href.split('#')[0] + hash, '_blank', 'width=900,height=1000')
}
