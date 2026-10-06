/**
 * Game balance + content tables, shared verbatim by the server (authoritative
 * economy) and the client (UI, previews, physics tuning).
 *
 * SOURCE OF TRUTH: speed-skateboard-escape-server/src/shared/.
 * The client keeps a copy in src/shared/ — run `npm run sync-shared` in the client
 * after editing anything here.
 */

export const GAME_ID = 'speed-skateboard-escape'
export const ROOM_NAME = 'skate'
export const MAX_PLAYERS = 8

export const MAX_LEVEL = 25
/** Sunny Skatepark has five bonus stages; Neon City keeps its ten-stage run. */
export const STAGE_COUNTS = [15, 10]
export const STAGE_OFFSETS = [0, STAGE_COUNTS[0]]
export const STAGES_PER_WORLD = Math.max(...STAGE_COUNTS)
export const stageCount = (world) => STAGE_COUNTS[world] || 0
export const stageNumber = (world, stage) => (STAGE_OFFSETS[world] || 0) + stage
export const WORLD_COUNT = 2
/** Rebirths needed to enter each world. */
export const WORLD_UNLOCK_REBIRTHS = [0, 3]
export const WORLD_NAMES = ['Sunny Skatepark', 'Neon City']

/** Server economy tick. Speed is earned once per tick while riding / on a treadmill. */
export const TICK_MS = 500

/* ------------------------------------------------------------------ physics */

export const GRAVITY = 26
export const JUMP_VELOCITY = 9
/** Time a flat jump spends in the air. */
export const AIR_TIME = (2 * JUMP_VELOCITY) / GRAVITY

/* --------------------------------------------------------------- skateboards */

/**
 * `bonus` is added to the +1 base speed earned per tick, `move` is extra top speed
 * in m/s. World-2 boards only appear in the World 2 lobby.
 */
export const BOARDS = [
  { id: 1, name: 'Starter', bonus: 1, cost: 0, world: 0, deck: '#2b2b33', grip: '#151518', wheel: '#f2f2f2' },
  { id: 2, name: 'Cherry', bonus: 2, cost: 3, world: 0, deck: '#e8323c', grip: '#1c1c1f', wheel: '#ffffff' },
  { id: 3, name: 'Ocean', bonus: 4, cost: 15, world: 0, deck: '#2f4cf0', grip: '#1c1c1f', wheel: '#a7e7ff' },
  { id: 4, name: 'Lime', bonus: 8, cost: 100, world: 0, deck: '#39e639', grip: '#1c1c1f', wheel: '#ffffff' },
  { id: 5, name: 'Bubblegum', bonus: 16, cost: 500, world: 0, deck: '#ff3fd2', grip: '#1c1c1f', wheel: '#ffe1f6' },
  { id: 6, name: 'Grape', bonus: 32, cost: 2500, world: 0, deck: '#9a37ff', grip: '#1c1c1f', wheel: '#e6d0ff' },
  { id: 7, name: 'Sunshine', bonus: 64, cost: 15000, world: 0, deck: '#ffd21f', grip: '#1c1c1f', wheel: '#ffffff' },
  { id: 8, name: 'Rainbow', bonus: 128, cost: 75000, world: 0, deck: 'rainbow', grip: '#1c1c1f', wheel: '#ffffff', glow: 0.25 },
  { id: 9, name: 'Galaxy', bonus: 256, cost: 375000, world: 0, deck: '#3a1d7a', grip: '#0d0820', wheel: '#ff8af0', glow: 0.5 },
  { id: 10, name: 'Frost', bonus: 512, cost: 2060000, world: 0, deck: '#5ff2ff', grip: '#10303a', wheel: '#ffffff', glow: 0.6 },
  { id: 11, name: 'Magma', bonus: 1024, cost: 10e6, world: 1, deck: '#ff5a12', grip: '#2a0a00', wheel: '#ffd27a', glow: 0.8 },
  { id: 12, name: 'Toxic', bonus: 2048, cost: 50e6, world: 1, deck: '#8cff1a', grip: '#122a00', wheel: '#eaffc2', glow: 0.8 },
  { id: 13, name: 'Golden', bonus: 4096, cost: 250e6, world: 1, deck: '#ffbf00', grip: '#3a2a00', wheel: '#fff4c2', glow: 0.9 },
  { id: 14, name: 'Diamond', bonus: 8192, cost: 1.25e9, world: 1, deck: '#b8f6ff', grip: '#1b3b52', wheel: '#ffffff', glow: 1 },
  { id: 15, name: 'Cosmic', bonus: 16384, cost: 6e9, world: 1, deck: 'cosmic', grip: '#05010f', wheel: '#ff5cf4', glow: 1.2 },
].map((b, i) => ({ ...b, tier: i, move: i * 0.2 }))

export const boardById = (id) => BOARDS.find((b) => b.id === id) || BOARDS[0]

/* ---------------------------------------------------------------- treadmills */

/** Lobby treadmills, per world. Index 0 of world 0 is free and owned by everyone. */
export const LOBBY_TREADMILLS = [
  [
    { mult: 1.5, cost: 0, color: '#f4f4f8' },
    { mult: 2, cost: 15, color: '#7dff5a' },
    { mult: 3, cost: 50, color: '#ffd21f' },
    { mult: 5, cost: 150, color: '#ff9a1f' },
    { mult: 9, cost: 500, color: '#3fe8ff' },
    { mult: 15, cost: 1500, color: '#3f7bff' },
    { mult: 25, cost: 5000, color: '#ff3fe0' },
    { mult: 40, cost: 15000, color: '#b13bff' },
  ],
  [
    { mult: 50, cost: 100e3, color: '#7dff5a' },
    { mult: 80, cost: 300e3, color: '#2af5c8' },
    { mult: 120, cost: 1e6, color: '#ffb31f' },
    { mult: 200, cost: 3e6, color: '#ff6b4d' },
    { mult: 300, cost: 10e6, color: '#3f8cff' },
    { mult: 500, cost: 30e6, color: '#b84dff' },
    { mult: 800, cost: 100e6, color: '#ff2f6d' },
    { mult: 1200, cost: 300e6, color: '#ffe14d' },
  ],
]
export const lobbyTreadmillId = (w, i) => `t${w}_${i}`

/** Free treadmills either side of every stage's finish gate. */
export function stageTreadmillMult(w, stage, side) {
  if (w === 0) return side === 0 ? 1 + stage * 0.5 : 3 + stage * 2
  return side === 0 ? 20 + stage * 10 : 60 + stage * 40
}
export const stageTreadmillId = (w, stage, side) => `s${w}_${stage}_${side}`

/* -------------------------------------------------------------------- trails */

export const TRAILS = [
  { id: 1, name: 'Red Trail', mult: 1.25, cost: 500, color: '#ff3b3b' },
  { id: 2, name: 'Blue Trail', mult: 1.5, cost: 5000, color: '#3b7bff' },
  { id: 3, name: 'Green Trail', mult: 2, cost: 50e3, color: '#38f05a' },
  { id: 4, name: 'Purple Trail', mult: 2.5, cost: 500e3, color: '#b43bff' },
  { id: 5, name: 'Gold Trail', mult: 3, cost: 5e6, color: '#ffc81f' },
  { id: 6, name: 'Rainbow Trail', mult: 4, cost: 50e6, color: 'rainbow' },
]
export const trailById = (id) => TRAILS.find((t) => t.id === id) || null

/* --------------------------------------------------------------------- glows */

/**
 * Underglow: a coloured light pool under the board while you ride. Every board
 * has its own glow colour by default; these replace it (bought with Wins).
 * fx: steady | pulse | flicker | sparkle | rainbow
 */
export const GLOWS = [
  { id: 1, name: 'Ice Glow', cost: 200, color: '#7fe9ff', fx: 'steady' },
  { id: 2, name: 'Bubblegum Glow', cost: 800, color: '#ff5ad8', fx: 'pulse' },
  { id: 3, name: 'Lava Glow', cost: 3000, color: '#ff5a12', fx: 'flicker' },
  { id: 4, name: 'Toxic Glow', cost: 12e3, color: '#8cff1a', fx: 'pulse' },
  { id: 5, name: 'Royal Glow', cost: 50e3, color: '#a43bff', fx: 'sparkle' },
  { id: 6, name: 'Golden Glow', cost: 250e3, color: '#ffc81f', fx: 'sparkle' },
  { id: 7, name: 'Rainbow Glow', cost: 1.5e6, color: 'rainbow', fx: 'rainbow' },
]
export const glowById = (id) => GLOWS.find((g) => g.id === id) || null

/** The default underglow colour of a board (its deck colour). */
export function boardGlowColor(board) {
  if (board.deck === 'rainbow') return '#ff66cc'
  if (board.deck === 'cosmic') return '#9a4dff'
  if (board.deck === '#2b2b33') return '#9fb4ff'
  return board.deck
}

/* -------------------------------------------------------------------- charms */

export const RARITIES = {
  common: { name: 'Common', color: '#9aa3b5', weight: 50 },
  rare: { name: 'Rare', color: '#3b8bff', weight: 30 },
  epic: { name: 'Epic', color: '#b13bff', weight: 14 },
  legendary: { name: 'Legendary', color: '#ffb000', weight: 5 },
  mythic: { name: 'Mythic', color: '#ff2f55', weight: 1 },
}

/** `stat` is 'speed' or 'wins'; `pct` is the bonus when equipped. */
export const CHARMS = [
  { id: 'clover', name: 'Lucky Clover', rarity: 'common', stat: 'speed', pct: 3, cost: 40, icon: 'clover' },
  { id: 'sneaker', name: 'Old Sneaker', rarity: 'common', stat: 'wins', pct: 3, cost: 40, icon: 'sneaker' },
  { id: 'book', name: 'Guide Book', rarity: 'rare', stat: 'wins', pct: 5, cost: 250, icon: 'book' },
  { id: 'bolt', name: 'Turbo Bolt', rarity: 'rare', stat: 'speed', pct: 5, cost: 250, icon: 'bolt' },
  { id: 'ring', name: 'Gold Ring', rarity: 'epic', stat: 'speed', pct: 6, cost: 2500, icon: 'ring' },
  { id: 'magnifier', name: 'Win Magnifier', rarity: 'epic', stat: 'wins', pct: 6, cost: 2500, icon: 'magnifier' },
  { id: 'wing', name: 'Angel Wing', rarity: 'legendary', stat: 'speed', pct: 10, cost: 25e3, icon: 'wing' },
  { id: 'crown', name: 'Royal Crown', rarity: 'legendary', stat: 'wins', pct: 12, cost: 25e3, icon: 'crown' },
  { id: 'comet', name: 'Comet Core', rarity: 'mythic', stat: 'speed', pct: 20, cost: 250e3, icon: 'comet' },
  { id: 'trophy', name: 'Golden Trophy', rarity: 'mythic', stat: 'wins', pct: 20, cost: 250e3, icon: 'trophy' },
]
export const charmById = (id) => CHARMS.find((c) => c.id === id) || null
export const MAX_EQUIPPED_CHARMS = 3
export const CHARM_RESTOCK_MS = 5 * 60 * 1000
export const CHARM_SLOTS = 3
export const charmRefreshCost = (rebirths) => 25 * (rebirths + 1)

/* ------------------------------------------------------------------- stages */

/** Every stage is its own little adventure. */
export const STAGE_NAMES = [
  [
    'Rookie Plaza',
    'Stair Street',
    "Granny's Block",
    'Rail Yard',
    'Bowl Bash',
    'Construction Chaos',
    'Mega Ramp',
    'Floating Park',
    'Pipe Dream',
    'The Great Escape',
    'Riverbend Run',
    'Crumbling Bridges',
    'Canyon Hills',
    'Trick Garden',
    'Sunset Showdown',
  ],
  ['Neon Alley', 'Laser Stairs', 'Arcade Bowl', 'Hover Rails', 'Night Granny', 'Glitch Factory', 'Sky Drop', 'Data Stream', 'Cyber Pipe', 'Final Glitch'],
]

export const RECOMMENDED_LEVEL = [
  [0, 2, 4, 6, 9, 12, 15, 18, 21, 24, 25, 25, 25, 25, 25],
  [2, 5, 8, 11, 14, 17, 19, 21, 23, 25],
]
/**
 * Teleporting to an unlocked stage costs a small fee in Wins: the same as one
 * free win pad on that stage, so it never costs more than a run would earn.
 * Lobby spots are always free.
 */
export const teleportCost = (w, s) => Math.max(1, STAGE_WINS[w][s - 1])

/** Premium (right-hand) finish side: unlock once per stage with Wins. */
export const PREMIUM_PAD_MULT = 3
export const premiumPadCost = (w, s) => STAGE_WINS[w][s - 1] * 25
export const premiumTreadmillCost = (w, s) => STAGE_WINS[w][s - 1] * 15

export const STAGE_WINS = [
  [1, 2, 4, 7, 12, 20, 35, 60, 100, 160, 250, 400, 650, 1000, 1600],
  [400, 700, 1100, 1700, 2600, 4000, 6000, 9000, 14000, 22000],
]

/* ---------------------------------------------------------------- shop packs */

/** The bottom-bar speed packs, paid in wins. */
export const SPEED_PACKS = [
  { id: 0, label: '+1K', amount: 1e3, cost: 15, color: 'green' },
  { id: 1, label: '+10K', amount: 1e4, cost: 120, color: 'purple' },
  { id: 2, label: '+100K', amount: 1e5, cost: 1000, color: 'red' },
  { id: 3, label: '+1M', amount: 1e6, cost: 8000, color: 'gold' },
]

export const BOOST_MINUTES = 10
export const boostCost = (kind, rebirths) =>
  (kind === 'speed' ? 30 : 60) * (rebirths + 1) * (rebirths + 1)

/* ---------------------------------------------------------------- progression */

/** Total speed needed to *reach* `level` with `rebirths` rebirths. */
export function speedForLevel(level, rebirths = 0) {
  if (level <= 0) return 0
  return Math.round((10 * Math.pow(level, 2.3) + 20 * level) * Math.pow(2.5, rebirths))
}

export function levelFromSpeed(speed, rebirths = 0) {
  let level = 0
  while (level < MAX_LEVEL && speed >= speedForLevel(level + 1, rebirths)) level += 1
  return level
}

/** { level, into, need } — progress inside the current level, for the XP bar. */
export function levelProgress(speed, rebirths = 0) {
  const level = levelFromSpeed(speed, rebirths)
  if (level >= MAX_LEVEL) return { level, into: 1, need: 1, max: true }
  const base = speedForLevel(level, rebirths)
  const next = speedForLevel(level + 1, rebirths)
  return { level, into: Math.max(0, Math.floor(speed - base)), need: next - base, max: false }
}

/** Top riding speed in m/s. Level is the main driver, boards add a little. */
export function moveSpeedFor(level, boardId = 1) {
  return 8 + 0.6 * Math.min(level, MAX_LEVEL) + boardById(boardId).move
}

export const rebirthSpeedMult = (r) => 1 + 0.5 * r
export const rebirthWinsMult = (r) => 1 + 0.25 * r
/** +10% per other rider in the server. */
export const squadBoost = (playersInRoom) => Math.min(0.7, Math.max(0, playersInRoom - 1) * 0.1)

/* -------------------------------------------------------------------- quests */

export const QUESTS = [
  { type: 'treadmill', target: 1, text: 'Find a Treadmill', wins: 2 },
  { type: 'level', target: 3, text: 'Reach Level 3', wins: 2 },
  { type: 'claims', target: 3, text: 'Get Wins', wins: 3, counter: true },
  { type: 'boards', target: 2, text: 'Buy a Skateboard', wins: 5 },
  { type: 'stage', target: 3, text: 'Escape Stage 3', wins: 8 },
  { type: 'level', target: 10, text: 'Reach Level 10', wins: 10 },
  { type: 'treadmills', target: 2, text: 'Buy a Treadmill', wins: 15 },
  { type: 'stage', target: 5, text: 'Escape Stage 5', wins: 25 },
  { type: 'charm', target: 1, text: 'Equip a Charm', wins: 25 },
  { type: 'level', target: 25, text: 'Reach Max Level', wins: 60 },
  { type: 'rebirth', target: 1, text: 'Rebirth', wins: 100 },
  { type: 'stage', target: 10, text: 'Escape Stage 10', wins: 250 },
  { type: 'rebirth', target: 3, text: 'Reach 3 Rebirths', wins: 500 },
  { type: 'world', target: 2, text: 'Enter World 2', wins: 2000 },
  { type: 'stage', target: 15, text: 'Escape Stage 15', wins: 20000 },
  { type: 'stage', target: 20, text: 'Escape Stage 20', wins: 100000 },
]

/** After the scripted chain, an endless "next rebirth" quest. */
export function questAt(index, rebirths) {
  if (index < QUESTS.length) return QUESTS[index]
  const target = rebirths + 1
  return { type: 'rebirth', target, text: `Reach ${target} Rebirths`, wins: Math.round(200 * Math.pow(1.6, target)) }
}

/* ------------------------------------------------------------------ rewards */

/** Daily streak, cycling every 7 days. Amounts scale with rebirths. */
export const DAILY_REWARDS = [
  { wins: 10 },
  { speed: 500 },
  { wins: 25 },
  { boost: 'speed' },
  { wins: 60 },
  { boost: 'wins' },
  { wins: 150 },
]

/** Session playtime gifts, in minutes. */
export const PLAYTIME_GIFTS = [
  { min: 1, wins: 2 },
  { min: 3, speed: 300 },
  { min: 5, wins: 6 },
  { min: 10, boost: 'speed' },
  { min: 15, wins: 15 },
  { min: 20, speed: 3000 },
  { min: 30, boost: 'wins' },
  { min: 45, wins: 60 },
  { min: 60, wins: 120 },
]

/** Scales a reward entry for the player's rebirth count. */
export function scaleReward(reward, rebirths) {
  const out = { ...reward }
  if (out.wins) out.wins = Math.round(out.wins * (1 + rebirths))
  if (out.speed) out.speed = Math.round(out.speed * Math.pow(2.5, rebirths))
  return out
}

/* ------------------------------------------------------------------- format */

const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc']

/** 1234 -> "1.23K", 2060000 -> "2.06M". */
export function formatNum(value) {
  const n = Number(value) || 0
  if (Math.abs(n) < 1000) return String(Math.floor(n))
  let tier = Math.floor(Math.log10(Math.abs(n)) / 3)
  tier = Math.min(tier, SUFFIXES.length - 1)
  const scaled = n / Math.pow(1000, tier)
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${Number(scaled.toFixed(digits))}${SUFFIXES[tier]}`
}
