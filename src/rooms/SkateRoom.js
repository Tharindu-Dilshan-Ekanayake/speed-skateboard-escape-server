import { Room } from '@colyseus/core'

import { verifySession } from '../auth.js'
import { getLeaderboards, loadProfile, saveProfile, invalidateLeaderboards } from '../db.js'
import {
  advanceQuests,
  buyBoard,
  buyBoost,
  buyCharm,
  buyGlow,
  buyPack,
  buyPremium,
  buyTrail,
  buyTreadmill,
  changeWorld,
  charmPct,
  claimDaily,
  equipBoard,
  grantReward,
  levelOf,
  normalizeProfile,
  privateView,
  questBump,
  rebirth,
  refreshCharms,
  toggleCharm,
} from '../profile.js'
import { PlayerState, SkateState } from '../schema.js'
import {
  MAX_PLAYERS,
  PLAYTIME_GIFTS,
  stageCount,
  stageNumber,
  TICK_MS,
  boardById,
  moveSpeedFor,
  rebirthSpeedMult,
  rebirthWinsMult,
  scaleReward,
  teleportCost,
  squadBoost,
  trailById,
} from '../shared/config.js'
import { KILL_Y, getWorlds, inRect, treadmillAt, winPadAt, worldOfX } from '../shared/layout.js'

const SAVE_EVERY_MS = 20_000
const LB_EVERY_MS = 60_000
const ME_EVERY_MS = 10_000

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)


/**
 * One lobby of up to 8 riders. Colyseus' joinOrCreate fills a room to
 * MAX_PLAYERS and then opens a new one, so a 9th player lands in a fresh lobby.
 *
 * The server is authoritative for everything that matters (speed, wins,
 * purchases, unlocks). Clients simulate their own movement; the server checks it
 * against a distance budget derived from the rider's legal top speed.
 */
export class SkateRoom extends Room {
  maxClients = MAX_PLAYERS
  patchRate = 50
  maxMessagesPerSecond = 90

  onCreate() {
    this.setState(new SkateState())
    this.worlds = getWorlds()
    /** sessionId -> per-connection server data */
    this.sessions = new Map()
    this.shuttingDown = false

    this.clock.setInterval(() => this.tick(), TICK_MS)
    this.clock.setInterval(() => this.saveAll(false), SAVE_EVERY_MS)
    this.clock.setInterval(() => this.pushLeaderboards(), LB_EVERY_MS)
    this.clock.setInterval(() => {
      for (const s of this.sessions.values()) this.sendMe(s)
    }, ME_EVERY_MS)

    this.registerMessages()
  }

  onAuth(_client, options) {
    const session = verifySession(options?.token)
    if (!session) throw new Error('unauthorized')
    return session
  }

  async onJoin(client, options, auth) {
    const pid = auth.pid
    const name = auth.name || 'Player'

    // The same account in another tab: take over its live profile (newest wins).
    let profile = null
    for (const [sid, other] of this.sessions) {
      if (other.pid === pid) {
        profile = other.profile
        other.replaced = true
        this.sessions.delete(sid)
        this.state.players.delete(sid)
        other.client.leave(4777) // client shows "playing in another tab"
      }
    }
    if (!profile) profile = normalizeProfile(await loadProfile(pid), pid, name)
    profile.name = name

    const player = new PlayerState()
    player.name = name
    player.look = sanitizeLook(options?.look)
    player.st = cleanStyle(options?.style)
    this.state.players.set(client.sessionId, player)

    const s = {
      client,
      pid,
      profile,
      player,
      pos: [0, 0, 0],
      lastTickPos: [0, 0, 0],
      budget: 0,
      lastMoveAt: Date.now(),
      lastBudgetAt: Date.now(),
      tpSeq: 0,
      checkpoint: 0,
      armed: new Set(),
      treadmill: null,
      playSeconds: 0,
      gifts: new Set(),
      lastTpAt: 0,
      dirty: true,
      replaced: false,
    }
    this.sessions.set(client.sessionId, s)

    this.syncPublic(s)
    // Rejoining after a reconnect or a deploy drain: put the rider back at the
    // start of the stage they were on, if they have unlocked it.
    const resume = Math.floor(Number(options?.resume?.stage))
    const layout = this.layoutOf(s)
    if (resume >= 1 && resume <= profile.maxStage[profile.world]) {
      s.checkpoint = resume
      s.armed.add(resume)
      this.teleport(s, layout.stages[resume - 1].spawn, Math.PI)
    } else {
      this.teleport(s, layout.spawn, Math.PI)
    }
    advanceQuests(profile)
    this.sendMe(s)
    client.send('time', { s: Date.now() })
    getLeaderboards().then((lb) => client.send('lb', lb)).catch(() => {})
  }

  onDrop(client) {
    // Brief network blips keep the rider in the world; the SDK reconnects itself.
    this.allowReconnection(client, 20)
  }

  async onLeave(client) {
    const s = this.sessions.get(client.sessionId)
    this.sessions.delete(client.sessionId)
    this.state.players.delete(client.sessionId)
    if (s && !s.replaced) await saveProfile(s.profile)
  }

  async onDispose() {
    await this.saveAll(true)
  }

  onBeforeShutdown() {
    // Deploy / scale-down drain: persist everyone, then ask clients to hop to a
    // fresh pod. The room disposes once they have left.
    this.shuttingDown = true
    this.lock().catch(() => {})
    this.saveAll(true).finally(() => {
      this.broadcast('migrate', {})
      this.clock.setTimeout(() => this.disconnect().catch(() => {}), 4000)
    })
  }

  onUncaughtException(err, method) {
    console.error(`[room ${this.roomId}] ${method}:`, err)
  }

  /* --------------------------------------------------------------- helpers */

  layoutOf(s) {
    return this.worlds[s.profile.world]
  }

  lobbySpawn(w) {
    return this.worlds[w].spawn
  }

  syncPublic(s) {
    const p = s.profile
    const pl = s.player
    pl.board = p.board
    pl.trail = p.trail
    pl.gl = p.glow
    pl.level = levelOf(p)
    pl.rebirths = Math.min(65535, p.rebirths)
    pl.world = p.world
    pl.speed = p.speed
    pl.wins = p.wins
  }

  sendMe(s) {
    const view = privateView(s.profile)
    view.session = { playSeconds: Math.floor(s.playSeconds), gifts: [...s.gifts] }
    view.now = Date.now()
    s.client.send('me', view)
  }

  /** Server-driven teleport. Movement packets older than this seq are ignored. */
  teleport(s, pos, ry = Math.PI) {
    s.tpSeq = (s.tpSeq + 1) % 1_000_000
    s.pos = [pos[0], pos[1], pos[2]]
    s.lastTickPos = [...s.pos]
    s.budget = 0
    s.lastBudgetAt = Date.now()
    s.treadmill = null
    const pl = s.player
    pl.x = pos[0]
    pl.y = pos[1]
    pl.z = pos[2]
    pl.ry = ry
    s.client.send('tp', { p: s.pos, ry, seq: s.tpSeq })
  }

  result(s, action, code, extra) {
    s.client.send('res', { action, code, ...extra })
    if (code === 'ok' || code === 'equipped' || code === 'unequipped') {
      s.dirty = true
      this.afterChange(s)
    }
  }

  afterChange(s) {
    for (const q of advanceQuests(s.profile)) s.client.send('fx', { k: 'quest', text: q.text, n: q.wins })
    this.syncPublic(s)
    this.sendMe(s)
  }

  /* -------------------------------------------------------------- messages */

  registerMessages() {
    const on = (type, fn) =>
      this.onMessage(type, (client, msg) => {
        const s = this.sessions.get(client.sessionId)
        if (!s || this.shuttingDown) return
        fn(s, msg ?? {})
      })

    on('m', (s, m) => this.onMove(s, m))
    on('ping', (s, m) => s.client.send('pong', { c: m.c, s: Date.now() }))
    on('style', (s, m) => {
      s.player.st = cleanStyle(m.style)
    })

    on('respawn', (s) => {
      const layout = this.layoutOf(s)
      // Falling or hitting an obstacle in a stage always sends the rider back
      // to the current world's lobby; a fresh run starts from there.
      s.checkpoint = 0
      s.armed.clear()
      this.teleport(s, this.lobbySpawn(s.profile.world), Math.PI)
    })

    on('tp', (s, m) => {
      const now = Date.now()
      if (now - s.lastTpAt < 800) return
      s.lastTpAt = now
      const layout = this.layoutOf(s)
      const p = s.profile
      if (m.to === 'stage') {
        const stage = Math.floor(Number(m.stage))
        if (!(stage >= 1 && stage <= p.maxStage[p.world])) return this.result(s, 'tp', 'locked')
        const cost = teleportCost(p.world, stage)
        if (p.wins < cost) return this.result(s, 'tp', 'wins')
        p.wins -= cost
        s.dirty = true
        this.afterChange(s)
        s.checkpoint = stage
        s.armed.add(stage)
        return this.teleport(s, layout.stages[stage - 1].spawn, Math.PI)
      }
      const spot = layout.lobby[m.to] || layout.spawn
      s.checkpoint = 0
      this.teleport(s, spot, Math.PI)
    })

    on('world', (s, m) => {
      const code = changeWorld(s.profile, Math.floor(Number(m.w)))
      if (code === 'ok') {
        s.checkpoint = 0
        s.armed.clear()
        this.teleport(s, this.lobbySpawn(s.profile.world), Math.PI)
      }
      this.result(s, 'world', code)
    })

    on('claim', (s) => this.onClaim(s))

    on('buyBoard', (s, m) => this.result(s, 'buyBoard', buyBoard(s.profile, Math.floor(Number(m.id))), { id: m.id }))
    on('equipBoard', (s, m) => this.result(s, 'equipBoard', equipBoard(s.profile, Math.floor(Number(m.id))), { id: m.id }))
    on('buyTreadmill', (s, m) => this.result(s, 'buyTreadmill', buyTreadmill(s.profile, String(m.id || '')), { id: m.id }))
    on('buyTrail', (s, m) => this.result(s, 'buyTrail', buyTrail(s.profile, Math.floor(Number(m.id))), { id: m.id }))
    on('buyPremium', (s, m) => this.result(s, 'buyPremium', buyPremium(s.profile, String(m.id || '')), { id: m.id }))
    on('buyGlow', (s, m) => this.result(s, 'buyGlow', buyGlow(s.profile, Math.floor(Number(m.id))), { id: m.id }))
    on('buyCharm', (s, m) => this.result(s, 'buyCharm', buyCharm(s.profile, Math.floor(Number(m.slot)))))
    on('refreshCharms', (s) => this.result(s, 'refreshCharms', refreshCharms(s.profile)))
    on('toggleCharm', (s, m) => this.result(s, 'toggleCharm', toggleCharm(s.profile, String(m.id || ''))))
    on('buyPack', (s, m) => this.result(s, 'buyPack', buyPack(s.profile, Math.floor(Number(m.id))), { id: m.id }))
    on('buyBoost', (s, m) => this.result(s, 'buyBoost', buyBoost(s.profile, String(m.kind)), { kind: m.kind }))

    on('rebirth', (s) => {
      const code = rebirth(s.profile)
      if (code === 'ok') invalidateLeaderboards()
      this.result(s, 'rebirth', code, { rebirths: s.profile.rebirths })
    })

    on('daily', (s) => {
      const { code, reward } = claimDaily(s.profile)
      this.result(s, 'daily', code, { reward })
    })

    on('gift', (s, m) => {
      const i = Math.floor(Number(m.i))
      const gift = PLAYTIME_GIFTS[i]
      if (!gift) return this.result(s, 'gift', 'invalid')
      if (s.gifts.has(i)) return this.result(s, 'gift', 'claimed')
      if (s.playSeconds < gift.min * 60) return this.result(s, 'gift', 'early')
      s.gifts.add(i)
      const reward = scaleReward(gift, s.profile.rebirths)
      grantReward(s.profile, reward)
      this.result(s, 'gift', 'ok', { reward })
    })
  }

  onMove(s, m) {
    if (!Array.isArray(m) || m.length < 8) return
    const [x, y, z, ry, a, f, v, seq] = m
    if (!isNum(x) || !isNum(y) || !isNum(z) || !isNum(ry)) return
    if (seq !== s.tpSeq) return // stale packet from before a teleport

    const p = s.profile
    const layout = this.layoutOf(s)
    if (worldOfX(x) !== p.world || y < KILL_Y - 8 || y > 200) return

    // Distance budget: refills at the legal top speed (+ slack for slopes, rails
    // and network jitter), capped at ~3 s worth so lag bursts are absorbed.
    const now = Date.now()
    // 1.6x covers downhill rolls and rails; +18 m/s covers riding on a moving platform.
    const vmax = moveSpeedFor(levelOf(p), p.board) * 1.6 + 18
    s.budget = Math.min(vmax * 4 + 6, s.budget + vmax * ((now - s.lastBudgetAt) / 1000))
    s.lastBudgetAt = now
    const dist = Math.hypot(x - s.pos[0], z - s.pos[2])
    if (dist > s.budget) {
      // Too far, too fast: put the rider back where we last trusted them.
      this.teleport(s, s.pos, s.player.ry)
      return
    }
    s.budget -= dist
    s.pos = [x, y, z]
    if (dist > 0.05) s.lastMoveAt = now

    const pl = s.player
    pl.x = x
    pl.y = y
    pl.z = z
    pl.ry = ry
    pl.a = isNum(a) ? a & 255 : 1
    pl.f = isNum(f) ? f & 255 : 0
    pl.v = isNum(v) ? Math.max(0, Math.min(65535, Math.round(v * 10))) : 0

    // Stage starts: checkpoint, unlock, and arm the stage's win pads.
    for (const st of layout.stages) {
      if (!inRect(st.startRect, x, z)) continue
      if (s.checkpoint !== st.stage) {
        s.checkpoint = st.stage
        s.armed.add(st.stage)
        if (st.stage > p.maxStage[p.world]) {
          p.maxStage[p.world] = st.stage
          s.client.send('fx', { k: 'unlock', stage: stageNumber(p.world, st.stage) })
          s.dirty = true
        }
        if (st.stage > 1) {
          const beaten = stageNumber(p.world, st.stage) - 1
          if (beaten > p.stats.bestStage) p.stats.bestStage = beaten
        }
        this.afterChange(s)
      }
      break
    }

    // Treadmill (owned lobby treadmills, or any stage treadmill).
    const tm = treadmillAt(layout, x, y, z)
    const usable = tm && (!tm.cost || p.treadmills.includes(tm.id))
    if (usable && !s.treadmill && questBump(p, 'treadmill', 1)) this.afterChange(s)
    s.treadmill = usable ? tm : null
  }

  onClaim(s) {
    const p = s.profile
    const layout = this.layoutOf(s)
    const pad = winPadAt(layout, s.pos[0], s.pos[1], s.pos[2])
    if (!pad || !s.armed.has(pad.stage)) return
    if (pad.premium && !p.pads.includes(pad.id)) return
    s.armed.delete(pad.stage)

    const boosted = p.boosts.winsUntil > Date.now() ? 2 : 1
    const amount = Math.max(1, Math.round(pad.wins * rebirthWinsMult(p.rebirths) * (1 + charmPct(p, 'wins')) * boosted))
    p.wins += amount
    p.stats.totalWins += amount
    p.stats.claims += 1
    const global = stageNumber(p.world, pad.stage)
    if (global > p.stats.bestStage) p.stats.bestStage = global
    questBump(p, 'claims', 1)
    s.dirty = true

    s.client.send('fx', { k: 'wins', n: amount, stage: global })
    if (pad.kind === 'return') {
      s.checkpoint = 0
      this.teleport(s, layout.spawn, Math.PI)
    }
    this.afterChange(s)
  }

  /* ------------------------------------------------------------------ tick */

  tick() {
    const now = Date.now()
    const squad = squadBoost(this.sessions.size)
    for (const s of this.sessions.values()) {
      const p = s.profile
      s.playSeconds += TICK_MS / 1000

      const moved =
        Math.hypot(s.pos[0] - s.lastTickPos[0], s.pos[2] - s.lastTickPos[2]) > 0.8 && now - s.lastMoveAt < 1500
      s.lastTickPos = [...s.pos]

      // Re-validate the treadmill against the current position every tick.
      const layout = this.layoutOf(s)
      if (s.treadmill && !treadmillAt(layout, s.pos[0], s.pos[1], s.pos[2])) s.treadmill = null

      if (moved || s.treadmill) {
        const trail = trailById(p.trail)
        const gain =
          (1 + boardById(p.board).bonus) *
          (s.treadmill ? s.treadmill.mult : 1) *
          rebirthSpeedMult(p.rebirths) *
          (trail ? trail.mult : 1) *
          (1 + charmPct(p, 'speed')) *
          (p.boosts.speedUntil > now ? 2 : 1) *
          (1 + squad)
        const before = levelOf(p)
        p.speed += gain
        p.stats.totalSpeed += gain
        s.dirty = true
        const after = levelOf(p)
        if (after > before) {
          s.client.send('fx', { k: 'level', level: after })
          this.afterChange(s)
        }
      }
      p.stats.playSeconds = (p.stats.playSeconds || 0) + TICK_MS / 1000

      const pl = s.player
      pl.speed = p.speed
      pl.wins = p.wins
    }
  }

  async saveAll(force) {
    const jobs = []
    for (const s of this.sessions.values()) {
      if (!force && !s.dirty) continue
      s.dirty = false
      jobs.push(saveProfile(s.profile))
    }
    await Promise.all(jobs)
  }

  async pushLeaderboards() {
    try {
      const lb = await getLeaderboards()
      this.broadcast('lb', lb)
    } catch {
      /* leaderboards are cosmetic */
    }
  }
}

/** Riding style index, 0..2. */
function cleanStyle(v) {
  const n = Math.floor(Number(v))
  return n >= 0 && n <= 2 ? n : 0
}

/** Avatar JSON from the client: size-capped and re-serialised. */
function sanitizeLook(look) {
  if (typeof look !== 'string' || look.length > 4000) return ''
  try {
    const parsed = JSON.parse(look)
    return JSON.stringify({ equipped: parsed?.equipped ?? null, proportions: parsed?.proportions ?? null })
  } catch {
    return ''
  }
}
