import { Server } from '@colyseus/core'
import { WebSocketTransport } from '@colyseus/ws-transport'
import express from 'express'

import { cleanName, newGuestId, signSession, verifyBloxityToken, verifySession } from './auth.js'
import { connectDb, deleteProfile, getLeaderboards, loadProfile, saveProfile } from './db.js'
import { SkateRoom } from './rooms/SkateRoom.js'
import { ROOM_NAME } from './shared/config.js'

const PORT = Number(process.env.PORT) || 2567
const IS_PROD = process.env.NODE_ENV === 'production'

/* --------------------------------------------------------------------- CORS */

const configuredOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean)

function originAllowed(origin) {
  if (!origin) return false
  if (configuredOrigins.includes(origin)) return true
  if (/^https:\/\/([a-z0-9-]+\.)*bloxity\.io$/i.test(origin)) return true
  if (!IS_PROD && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true
  return false
}

function cors(req, res, next) {
  const origin = req.headers.origin
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
}

/* ------------------------------------------------------------ rate limiting */

const hits = new Map()
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`
    const now = Date.now()
    const entry = hits.get(key) || { n: 0, at: now }
    if (now - entry.at > windowMs) {
      entry.n = 0
      entry.at = now
    }
    entry.n += 1
    hits.set(key, entry)
    if (entry.n > limit) return res.status(429).json({ error: 'busy' })
    next()
  }
}
setInterval(() => {
  const cutoff = Date.now() - 120_000
  for (const [k, v] of hits) if (v.at < cutoff) hits.delete(k)
}, 60_000).unref()

/* ------------------------------------------------------------------ routes */

function routes(app) {
  app.set('trust proxy', true)
  app.get('/health', (_req, res) => res.status(200).send('ok'))
  app.get('/', (_req, res) => res.json({ game: 'speed-skateboard-escape', ok: true }))

  app.use('/api', cors, express.json({ limit: '16kb' }))

  /**
   * Guest sessions. A returning guest presents its old token and keeps its id;
   * anyone else gets a fresh random id. The token is the guest's "save file".
   */
  app.post('/api/guest', rateLimit(30, 60_000), (req, res) => {
    const prev = verifySession(req.body?.guestToken)
    const pid = prev && prev.pid.startsWith('g:') ? prev.pid : newGuestId()
    const name = cleanName(req.body?.name, `Guest${Math.floor(1000 + Math.random() * 9000)}`)
    res.json({ token: signSession({ pid, name, guest: true }, '365d'), name })
  })

  /**
   * Bloxity login. The platform token is verified server-side; the client's copy
   * of the user object is never trusted. A guest's progress is carried over the
   * first time that account plays.
   */
  app.post('/api/legion-auth', rateLimit(30, 60_000), async (req, res) => {
    let user
    try {
      user = await verifyBloxityToken(req.body?.token)
    } catch (err) {
      console.error('[auth] bloxity verify unreachable:', err.message)
      return res.status(503).json({ error: 'unavailable' })
    }
    if (!user) return res.status(401).json({ error: 'invalid' })

    const pid = `u:${user._id}`
    const name = cleanName(user.displayName || user.username, 'Player')

    const guest = verifySession(req.body?.guestToken)
    if (guest && guest.pid.startsWith('g:')) {
      try {
        const [account, guestDoc] = await Promise.all([loadProfile(pid), loadProfile(guest.pid)])
        if (!account && guestDoc) {
          await saveProfile({ ...guestDoc, _id: pid, name, mergedFrom: guest.pid })
          await deleteProfile(guest.pid)
        }
      } catch (err) {
        console.error('[auth] guest merge failed:', err.message)
      }
    }

    res.json({ token: signSession({ pid, name, guest: false }), name })
  })

  app.get('/api/leaderboard', async (_req, res) => {
    try {
      res.json(await getLeaderboards())
    } catch {
      res.json({ speed: [], wins: [], rebirths: [] })
    }
  })
}

/* ------------------------------------------------------------------- boot */

// Log stray promise rejections instead of crashing the pod. (Uncaught exceptions are
// handled by Colyseus, which drains rooms gracefully before exiting.)
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err))

const gameServer = new Server({
  transport: new WebSocketTransport({ pingInterval: 5000, pingMaxRetries: 4 }),
  greet: false,
  express: routes,
})

gameServer.define(ROOM_NAME, SkateRoom)

// Connect to the database in the background and open the port straight away, so
// the platform's health check passes immediately instead of after Mongo answers.
connectDb()
await gameServer.listen(PORT, '0.0.0.0')
console.log(`[server] listening on :${PORT} (${process.env.BLOXITY_CHANNEL || 'local'} ${process.env.POD_NAME || ''})`)
