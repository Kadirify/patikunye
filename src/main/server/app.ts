import Fastify, { type FastifyInstance } from 'fastify'
import { AppError, type AppDeps } from './context'
import { SessionStore, authRoutes } from './routes/auth'
import { ownerRoutes } from './routes/owners'
import { animalRoutes } from './routes/animals'
import { registerRoutes } from './routes/register'
import { petvetRoutes } from './routes/petvet'
import { visitsRoutes } from './routes/visits'
import { vaccinesRoutes } from './routes/vaccines'
import { messagingRoutes } from './routes/messaging'
import { appointmentsRoutes } from './routes/appointments'
import { adminRoutes } from './routes/admin'
import { backupRoutes } from './routes/backup'
import { reportsRoutes } from './routes/reports'
import { fileRoutes } from './files'
import { systemRoutes } from './routes/system'

export interface ServerOptions extends AppDeps {
  /** İzin verilen arayüz kökenleri (Electron: 'null' / file://, geliştirme: http://localhost:5173) */
  allowedOrigins: string[]
  /** Oturum deposu (yerel ağ dinleyicisiyle paylaşılır) */
  sessions?: SessionStore
  /** Yerel ağ dinleyicisi için TLS */
  https?: { key: string; cert: string }
  /** Yerel ağ dinleyicisi: cihaz doğrulama ve eşleştirme */
  lan?: {
    fingerprint: string
    version: string
    checkDevice(token: string, ip: string): Promise<boolean>
    pair(code: string, name: string, ip: string): Promise<{ deviceId: string; deviceToken: string } | null>
  }
  /** Ağ ayarları ekranı için denetleyici (yalnızca yerel dinleyicide) */
  network?: import('../network').NetworkController
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = (opts.https ? Fastify({ logger: false, bodyLimit: 1024 * 1024, https: opts.https }) : Fastify({ logger: false, bodyLimit: 1024 * 1024 })) as FastifyInstance
  const sessions = opts.sessions ?? new SessionStore()
  const lan = opts.lan

  if (lan) {
    // Ağdan gelen istekler: eşleştirme uçları dışında geçerli cihaz anahtarı zorunlu; kurulum ağdan yapılamaz
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return
      const path = req.url.split('?')[0]
      if (path === '/api/pair' || path === '/api/pair/hello' || path === '/api/health') return
      if (req.method !== 'GET' && (path.startsWith('/api/setup') || path.startsWith('/api/system/setup'))) {
        reply.code(403).send({ error: 'Kurulum yalnızca ana bilgisayarda yapılabilir.', code: 'LOCAL_ONLY' })
        return reply
      }
      const dev = req.headers['x-device-token']
      if (typeof dev !== 'string' || !(await lan.checkDevice(dev, req.ip))) {
        reply.code(401).send({ error: 'Bu bilgisayar ana bilgisayarla eşleştirilmemiş.', code: 'DEVICE' })
        return reply
      }
    })
    app.get('/api/pair/hello', async () => {
      const r = await opts.db.$client.query('select name from clinic limit 1')
      return { app: 'PatiKunye', clinicName: r.rows[0]?.name ?? '', fingerprint: lan.fingerprint, version: lan.version }
    })
    app.post('/api/pair', async (req) => {
      const b = (req.body ?? {}) as { code?: string; deviceName?: string; version?: string }
      if (b.version && b.version !== lan.version) {
        throw new AppError(409, `Sürüm uyumsuz: ana bilgisayar ${lan.version}, bu bilgisayar ${b.version}. Önce güncelleyin.`, 'VERSION_MISMATCH')
      }
      if (!b.code || !/^\d{6}$/.test(b.code) || !b.deviceName?.trim()) throw new AppError(400, 'Eşleştirme kodu ve cihaz adı gerekli.', 'VALIDATION')
      const r = await lan.pair(b.code, b.deviceName.trim(), req.ip)
      if (!r) throw new AppError(401, 'Eşleştirme kodu yanlış ya da süresi dolmuş.', 'BAD_CODE')
      return r
    })
  }

  // CORS: yalnızca bilinen arayüz kökenleri
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (origin) {
      if (!opts.allowedOrigins.includes(origin)) {
        reply.code(403).send({ error: 'İzin verilmeyen köken.' })
        return reply
      }
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      reply.header('Access-Control-Expose-Headers', 'Content-Disposition')
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send()
      return reply
    }
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (token) req.user = sessions.get(token)
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.code(err.status).send({ error: err.message, code: err.code, details: err.details })
      return
    }
    const fe = err as { statusCode?: number; message?: string; code?: string }
    if (fe.statusCode && fe.statusCode < 500) {
      reply.code(fe.statusCode).send({ error: fe.statusCode === 413 ? 'Gönderilen veri çok büyük.' : 'Geçersiz istek.', code: fe.code })
      return
    }
    opts.log?.(`[api] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    reply.code(500).send({ error: 'Beklenmeyen bir hata oluştu.', code: 'INTERNAL' })
  })

  app.get('/api/health', async () => ({ ok: true }))
  authRoutes(app, opts, sessions)
  ownerRoutes(app, opts)
  animalRoutes(app, opts)
  registerRoutes(app, opts)
  petvetRoutes(app, opts)
  fileRoutes(app, opts)
  visitsRoutes(app, opts)
  vaccinesRoutes(app, opts)
  messagingRoutes(app, opts)
  appointmentsRoutes(app, opts)
  adminRoutes(app, opts)
  backupRoutes(app, opts)
  reportsRoutes(app, opts)
  systemRoutes(app, opts)
  return app
}
