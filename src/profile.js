import {
  BOARDS,
  BOOST_MINUTES,
  CHARM_RESTOCK_MS,
  CHARM_SLOTS,
  CHARMS,
  DAILY_REWARDS,
  LOBBY_TREADMILLS,
  MAX_EQUIPPED_CHARMS,
  MAX_LEVEL,
  RARITIES,
  SPEED_PACKS,
  stageCount,
  TRAILS,
  WORLD_COUNT,
  glowById,
  WORLD_UNLOCK_REBIRTHS,
  boardById,
  boostCost,
  charmById,
  charmRefreshCost,
  levelFromSpeed,
  lobbyTreadmillId,
  questAt,
  scaleReward,
  trailById,
} from './shared/config.js'
import { premiumItem } from './shared/layout.js'

/**
 * Player profile: creation, migration of old/partial documents, and every
 * economy action. Actions mutate the profile and return a short result code the
 * client turns into its own friendly text (the server never sends display text).
 */

export function newProfile(id, name) {
  return {
    _id: id,
    name,
    createdAt: Date.now(),
    speed: 0,
    wins: 0,
    rebirths: 0,
    world: 0,
    maxStage: [1, 0],
    boards: [1],
    board: 1,
    treadmills: [lobbyTreadmillId(0, 0)],
    trails: [],
    trail: 0,
    glows: [],
    glow: 0,
    pads: [],
    charms: {},
    equippedCharms: [],
    charmReroll: 0,
    charmBought: [],
    boosts: { speedUntil: 0, winsUntil: 0 },
    quest: { i: 0, p: 0 },
    daily: { streak: 0, lastDay: '' },
    stats: { totalSpeed: 0, totalWins: 0, bestStage: 0, claims: 0, playSeconds: 0 },
  }
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** Fills missing fields so documents from older versions never crash the room. */
export function normalizeProfile(doc, id, name) {
  const base = newProfile(id, name)
  if (!doc) return base
  const p = { ...base, ...doc, _id: id }
  p.name = name || doc.name || base.name
  p.speed = Math.max(0, num(p.speed))
  p.wins = Math.max(0, num(p.wins))
  p.rebirths = Math.max(0, Math.floor(num(p.rebirths)))
  p.world = Math.min(WORLD_COUNT - 1, Math.max(0, Math.floor(num(p.world))))
  if (p.rebirths < WORLD_UNLOCK_REBIRTHS[p.world]) p.world = 0
  p.maxStage = Array.from({ length: WORLD_COUNT }, (_, w) =>
    Math.min(stageCount(w), Math.max(w === 0 ? 1 : 0, Math.floor(num(doc.maxStage?.[w], w === 0 ? 1 : 0)))),
  )
  p.boards = Array.isArray(p.boards) ? [...new Set([1, ...p.boards.filter((b) => BOARDS.some((x) => x.id === b))])] : [1]
  if (!p.boards.includes(p.board)) p.board = 1
  p.treadmills = Array.isArray(p.treadmills) ? [...new Set([lobbyTreadmillId(0, 0), ...p.treadmills.map(String)])] : base.treadmills
  p.trails = Array.isArray(p.trails) ? p.trails.filter((t) => trailById(t)) : []
  if (p.trail && !p.trails.includes(p.trail)) p.trail = 0
  p.pads = Array.isArray(p.pads) ? p.pads.filter((id) => premiumItem(id)).map(String) : []
  p.glows = Array.isArray(p.glows) ? p.glows.filter((g) => glowById(g)) : []
  if (p.glow && !p.glows.includes(p.glow)) p.glow = 0
  p.charms = p.charms && typeof p.charms === 'object' ? p.charms : {}
  p.equippedCharms = Array.isArray(p.equippedCharms) ? p.equippedCharms.filter((c) => charmById(c)).slice(0, MAX_EQUIPPED_CHARMS) : []
  p.charmBought = Array.isArray(p.charmBought) ? p.charmBought.slice(-30) : []
  p.boosts = { speedUntil: num(p.boosts?.speedUntil), winsUntil: num(p.boosts?.winsUntil) }
  p.quest = { i: Math.max(0, Math.floor(num(p.quest?.i))), p: Math.max(0, num(p.quest?.p)) }
  p.daily = { streak: Math.max(0, Math.floor(num(p.daily?.streak))), lastDay: String(p.daily?.lastDay || '') }
  p.stats = { ...base.stats, ...(doc.stats || {}) }
  return p
}

export const levelOf = (p) => levelFromSpeed(p.speed, p.rebirths)

export function charmPct(p, stat) {
  let pct = 0
  for (const id of p.equippedCharms) {
    const c = charmById(id)
    if (c && c.stat === stat) pct += c.pct
  }
  return pct / 100
}

/* ----------------------------------------------------------------- charms */

function hash32(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const rarityTotal = Object.values(RARITIES).reduce((s, r) => s + r.weight, 0)

/** The three personal offers for the current restock window. */
export function charmOffers(p, now = Date.now()) {
  const period = Math.floor(now / CHARM_RESTOCK_MS)
  const offers = []
  for (let slot = 0; slot < CHARM_SLOTS; slot += 1) {
    const h = hash32(`${p._id}:${period}:${p.charmReroll}:${slot}`)
    let roll = (h % 10000) / 10000 * rarityTotal
    let rarity = 'common'
    for (const [key, r] of Object.entries(RARITIES)) {
      if (roll < r.weight) {
        rarity = key
        break
      }
      roll -= r.weight
    }
    const pool = CHARMS.filter((c) => c.rarity === rarity)
    const charm = pool[(h >>> 12) % pool.length]
    const key = `${period}:${p.charmReroll}:${slot}`
    offers.push({ slot, id: charm.id, key, sold: p.charmBought.includes(key) })
  }
  return { period, restockAt: (period + 1) * CHARM_RESTOCK_MS, offers }
}

/* ---------------------------------------------------------------- actions */

const spend = (p, cost) => {
  if (p.wins < cost) return false
  p.wins -= cost
  return true
}

export function buyBoard(p, id) {
  const b = BOARDS.find((x) => x.id === id)
  if (!b) return 'invalid'
  if (p.boards.includes(id)) {
    p.board = id
    return 'equipped'
  }
  if (p.rebirths < WORLD_UNLOCK_REBIRTHS[b.world]) return 'locked'
  // Boards unlock in order: you must own the previous one first.
  const prev = BOARDS[BOARDS.findIndex((x) => x.id === id) - 1]
  if (prev && !p.boards.includes(prev.id)) return 'order'
  if (!spend(p, b.cost)) return 'wins'
  p.boards.push(id)
  p.board = id
  return 'ok'
}

export function equipBoard(p, id) {
  if (!p.boards.includes(id)) return 'invalid'
  p.board = id
  return 'equipped'
}

/** Unlocks a premium stage item (VIP win pad or VIP treadmill). */
export function buyPremium(p, id) {
  const entry = premiumItem(id)
  if (!entry) return 'invalid'
  const key = String(id)
  const list = entry.kind === 'pad' ? p.pads : p.treadmills
  if (list.includes(key)) return 'owned'
  if (p.rebirths < WORLD_UNLOCK_REBIRTHS[entry.item.world]) return 'locked'
  if (!spend(p, entry.item.cost)) return 'wins'
  list.push(key)
  return 'ok'
}

export function buyTreadmill(p, id) {
  if (premiumItem(id)) return buyPremium(p, id)
  const m = /^t(\d)_(\d)$/.exec(String(id))
  if (!m) return 'invalid'
  const w = Number(m[1])
  const def = LOBBY_TREADMILLS[w]?.[Number(m[2])]
  if (!def) return 'invalid'
  if (p.treadmills.includes(id)) return 'owned'
  if (p.rebirths < WORLD_UNLOCK_REBIRTHS[w]) return 'locked'
  if (!spend(p, def.cost)) return 'wins'
  p.treadmills.push(id)
  return 'ok'
}

export function buyTrail(p, id) {
  const tr = trailById(id)
  if (!tr) return 'invalid'
  if (p.trails.includes(id)) {
    p.trail = p.trail === id ? 0 : id
    return 'equipped'
  }
  if (!spend(p, tr.cost)) return 'wins'
  p.trails.push(id)
  p.trail = id
  return 'ok'
}

/** Buys a glow, or toggles it on/off if already owned. */
export function buyGlow(p, id) {
  const g = glowById(id)
  if (!g) return 'invalid'
  if (p.glows.includes(id)) {
    p.glow = p.glow === id ? 0 : id
    return p.glow ? 'equipped' : 'unequipped'
  }
  if (!spend(p, g.cost)) return 'wins'
  p.glows.push(id)
  p.glow = id
  return 'ok'
}

export function buyCharm(p, slot, now = Date.now()) {
  const { offers } = charmOffers(p, now)
  const offer = offers[slot]
  if (!offer) return 'invalid'
  if (offer.sold) return 'sold'
  const charm = charmById(offer.id)
  if (!spend(p, charm.cost)) return 'wins'
  p.charmBought.push(offer.key)
  p.charmBought = p.charmBought.slice(-30)
  p.charms[charm.id] = (p.charms[charm.id] || 0) + 1
  if (p.equippedCharms.length < MAX_EQUIPPED_CHARMS) p.equippedCharms.push(charm.id)
  return 'ok'
}

export function refreshCharms(p) {
  if (!spend(p, charmRefreshCost(p.rebirths))) return 'wins'
  p.charmReroll += 1
  return 'ok'
}

/** Toggles a charm in the equipped list, respecting how many copies are owned. */
export function toggleCharm(p, id) {
  const owned = p.charms[id] || 0
  if (!owned) return 'invalid'
  const equipped = p.equippedCharms.filter((c) => c === id).length
  if (equipped > 0 && equipped >= owned) {
    p.equippedCharms = p.equippedCharms.filter((c) => c !== id)
    return 'unequipped'
  }
  if (p.equippedCharms.length >= MAX_EQUIPPED_CHARMS) return 'full'
  p.equippedCharms.push(id)
  return 'equipped'
}

export function buyPack(p, i) {
  const pack = SPEED_PACKS[i]
  if (!pack) return 'invalid'
  if (!spend(p, pack.cost)) return 'wins'
  p.speed += pack.amount
  p.stats.totalSpeed += pack.amount
  return 'ok'
}

export function addBoost(p, kind, minutes = BOOST_MINUTES, now = Date.now()) {
  const key = kind === 'wins' ? 'winsUntil' : 'speedUntil'
  p.boosts[key] = Math.max(p.boosts[key], now) + minutes * 60_000
}

export function buyBoost(p, kind, now = Date.now()) {
  if (kind !== 'speed' && kind !== 'wins') return 'invalid'
  if (!spend(p, boostCost(kind, p.rebirths))) return 'wins'
  addBoost(p, kind, BOOST_MINUTES, now)
  return 'ok'
}

export function rebirth(p) {
  if (levelOf(p) < MAX_LEVEL) return 'level'
  p.rebirths += 1
  p.speed = 0
  return 'ok'
}

export function changeWorld(p, w) {
  if (!Number.isInteger(w) || w < 0 || w >= WORLD_COUNT) return 'invalid'
  if (p.rebirths < WORLD_UNLOCK_REBIRTHS[w]) return 'locked'
  p.world = w
  if (p.maxStage[w] < 1) p.maxStage[w] = 1
  return 'ok'
}

export function grantReward(p, reward, now = Date.now()) {
  if (reward.wins) {
    p.wins += reward.wins
    p.stats.totalWins += reward.wins
  }
  if (reward.speed) {
    p.speed += reward.speed
    p.stats.totalSpeed += reward.speed
  }
  if (reward.boost) addBoost(p, reward.boost, 5, now)
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10)

export function dailyStatus(p, now = Date.now()) {
  const today = dayKey(now)
  const yesterday = dayKey(now - 86_400_000)
  const claimedToday = p.daily.lastDay === today
  const continuing = p.daily.lastDay === yesterday || claimedToday
  const streak = continuing ? p.daily.streak : 0
  const nextIndex = claimedToday ? (streak - 1 + 7) % 7 : streak % 7
  return { claimedToday, streak, nextIndex }
}

export function claimDaily(p, now = Date.now()) {
  const st = dailyStatus(p, now)
  if (st.claimedToday) return { code: 'claimed' }
  const reward = scaleReward(DAILY_REWARDS[st.streak % 7], p.rebirths)
  p.daily = { streak: st.streak + 1, lastDay: dayKey(now) }
  grantReward(p, reward, now)
  return { code: 'ok', reward }
}

/* ----------------------------------------------------------------- quests */

/** Current progress value for a quest. Counter quests store progress in p.quest.p. */
export function questProgress(p, q) {
  switch (q.type) {
    case 'level':
      return levelOf(p)
    case 'claims':
    case 'treadmill':
      return p.quest.p
    case 'boards':
      return p.boards.length
    case 'treadmills':
      return p.treadmills.length
    case 'stage':
      return p.stats.bestStage
    case 'charm':
      return p.equippedCharms.length
    case 'rebirth':
      return p.rebirths
    case 'world':
      return p.world + 1
    default:
      return 0
  }
}

/** Completes as many quests as are already satisfied. Returns rewards granted. */
export function advanceQuests(p) {
  const done = []
  for (let guard = 0; guard < 50; guard += 1) {
    const q = questAt(p.quest.i, p.rebirths)
    if (questProgress(p, q) < q.target) break
    const wins = q.wins
    p.wins += wins
    p.stats.totalWins += wins
    done.push({ text: q.text, wins })
    p.quest = { i: p.quest.i + 1, p: 0 }
  }
  return done
}

/** Adds to a counter quest if it is the active one. Returns true when it did. */
export function questBump(p, type, amount = 1) {
  const q = questAt(p.quest.i, p.rebirths)
  if (q.type !== type) return false
  p.quest.p += amount
  return true
}

/** What the owner sees; never sent to other players. */
export function privateView(p, now = Date.now()) {
  const q = questAt(p.quest.i, p.rebirths)
  return {
    speed: p.speed,
    wins: p.wins,
    rebirths: p.rebirths,
    world: p.world,
    maxStage: p.maxStage,
    boards: p.boards,
    board: p.board,
    treadmills: p.treadmills,
    trails: p.trails,
    trail: p.trail,
    glows: p.glows,
    pads: p.pads,
    glow: p.glow,
    charms: p.charms,
    equippedCharms: p.equippedCharms,
    charmShop: charmOffers(p, now),
    boosts: p.boosts,
    quest: { text: q.text, target: q.target, progress: Math.min(q.target, questProgress(p, q)), counter: !!q.counter, wins: q.wins },
    daily: dailyStatus(p, now),
    stats: p.stats,
  }
}
