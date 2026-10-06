/**
 * Deterministic map generator: one lobby + 10 escape stages per world.
 *
 * The client renders and collides against everything returned here; the server
 * uses the same output to validate positions (stage starts, win pads, treadmills).
 * Never use Math.random in this file — both sides must produce identical maps.
 *
 * Conventions
 *  - Players run from the lobby toward -Z. Stage N+1 starts where stage N's gate is.
 *  - Walkable tops sit at y = 0. Water is at WATER_Y; dropping below KILL_Y respawns.
 *  - `wedge` primitives rise toward their local -Z (ry rotates them about Y).
 *  - Props stand on `p` (p is the centre of their base).
 *  - Rects are { x0, x1, z0, z1 } with x0 < x1 and z0 < z1.
 */

import {
  AIR_TIME,
  BOARDS,
  LOBBY_TREADMILLS,
  RECOMMENDED_LEVEL,
  PREMIUM_PAD_MULT,
  STAGE_NAMES,
  STAGE_WINS,
  STAGES_PER_WORLD,
  WORLD_COUNT,
  lobbyTreadmillId,
  moveSpeedFor,
  premiumPadCost,
  premiumTreadmillCost,
  stageTreadmillId,
  stageTreadmillMult,
} from './config.js'

export const WORLD_SPACING = 4000
export const TRACK_HALF = 18
export const WALL_H = 18
export const WATER_Y = -3
export const KILL_Y = -1.6
export const LOBBY_BACK_Z = -40
export const LOBBY_HALF_X = 48
export const LOBBY_FRONT_Z = 40
export const TREADMILL_HALF = { x: 1.8, z: 3.4 }
export const BOARD_PAD = { x: 6, z: 4.4 }

export const THEMES = [
  {
    floor: '#c9c4dc',
    floorAlt: '#b9b3d0',
    wall: '#e5763f',
    wallDark: '#c95e2c',
    wallTop: '#5fd35a',
    road: '#1e2b55',
    sidewalk: '#a7a3b8',
    water: '#35d8f0',
    wood: '#a4693e',
    metal: '#9aa2b4',
    trunk: '#7a4b2a',
    leaf: '#5ad85a',
    leafDark: '#3fb845',
    leafLight: '#8cf07a',
    rock: '#8e8a9c',
    accent: ['#ff4d4d', '#ffd21f', '#3fe8ff', '#9a5cff', '#ff7ad9', '#5cff7a'],
    houses: ['#ff7aa8', '#ffd45c', '#7ad8ff', '#a98bff', '#8cff9e', '#ff9d5c'],
    cars: ['#ff3b3b', '#3b7bff', '#ffd21f', '#38d05a', '#ffffff', '#ff8a1f'],
    sky: ['#2fb8ff', '#bfeaff'],
    fog: '#bfe3ff',
    sun: '#fff4dc',
  },
  {
    floor: '#3c4060',
    floorAlt: '#33374f',
    wall: '#5a3fb0',
    wallDark: '#42298c',
    wallTop: '#2af5c8',
    road: '#12162e',
    sidewalk: '#2e3150',
    water: '#ff4fd8',
    wood: '#4b3a7a',
    metal: '#7f8cff',
    trunk: '#3b2a5a',
    leaf: '#ff4fd8',
    leafDark: '#c63aa8',
    leafLight: '#ff9aec',
    rock: '#4a4670',
    accent: ['#2af5c8', '#ff4fd8', '#ffe14d', '#4da6ff', '#ff6b4d', '#b84dff'],
    houses: ['#2a1f55', '#1f2f55', '#3a1f45', '#1f3f45', '#45224a', '#28224a'],
    cars: ['#2af5c8', '#ff4fd8', '#ffe14d', '#4da6ff', '#ff6b4d', '#b84dff'],
    sky: ['#120a35', '#5a2a7a'],
    fog: '#3a2560',
    sun: '#d8c8ff',
  },
]

/** Collision footprints of props (x, height, z), shared with physics. */
export const PROPS = {
  bench: { s: [2.6, 0.9, 0.9], collide: true },
  trash: { s: [0.9, 1.2, 0.9], collide: true },
  cone: { s: [0.7, 0.9, 0.7], collide: true },
  barrel: { s: [1.1, 1.4, 1.1], collide: true },
  car: { s: [2.4, 1.7, 4.6], collide: true },
  hydrant: { s: [0.5, 0.9, 0.5], collide: true },
  planter: { s: [2.6, 0.8, 2.6], collide: true },
  lamp: { s: [0.3, 6.5, 0.3], collide: false },
  rock: { s: [2, 1.4, 2], collide: false },
  bush: { s: [2, 1.2, 2], collide: false },
}

/* ------------------------------------------------------------------ helpers */

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const r2 = (v) => Math.round(v * 100) / 100
const H = TRACK_HALF

class Builder {
  constructor(w) {
    this.w = w
    this.ox = w * WORLD_SPACING
    this.theme = THEMES[w]
    this.out = {
      world: w,
      ox: this.ox,
      theme: this.theme,
      boxes: [],
      wedges: [],
      pipes: [],
      cylinders: [],
      rails: [],
      water: [],
      winPads: [],
      treadmills: [],
      boardPads: [],
      obstacles: [],
      movers: [],
      signs: [],
      trees: [],
      props: [],
      stripes: [],
      stages: [],
      leaderboards: [],
      decor: [],
      spawn: null,
      spawnRy: Math.PI,
      lobby: null,
      portal: null,
      shopRect: null,
    }
  }

  /** Box (optionally Y-rotated). `p` is the centre. */
  box(p, s, mat = 'stud', color = this.theme.floor, opts = {}) {
    const b = {
      p: [r2(p[0] + this.ox), r2(p[1]), r2(p[2])],
      s: [r2(s[0]), r2(s[1]), r2(s[2])],
      ry: opts.ry || 0,
      mat,
      color,
      collide: opts.collide !== false,
      visible: opts.visible !== false,
    }
    this.out.boxes.push(b)
    return b
  }

  /** Floor slab whose top is at `top`, spanning z from zA down to zB (zB < zA). */
  floor(zA, zB, x0 = -H, x1 = H, color = this.theme.floor, mat = 'stud', top = 0) {
    return this.box([(x0 + x1) / 2, top - 0.5, (zA + zB) / 2], [x1 - x0, 1, zA - zB], mat, color)
  }

  /** Solid ramp. `p` = centre of the base footprint at height y. Rises toward local -Z. */
  wedge(p, s, ry = 0, mat = 'stud', color = this.theme.floor, opts = {}) {
    this.out.wedges.push({
      p: [r2(p[0] + this.ox), r2(p[1]), r2(p[2])],
      s: [r2(s[0]), r2(s[1]), r2(s[2])],
      ry,
      mat,
      color,
      collide: opts.collide !== false,
      visible: opts.visible !== false,
    })
  }

  /** Quarter pipe; curve rises toward local +X, extruded along local Z (`length`). */
  pipe(p, ry, length, radius, color = this.theme.floorAlt, phiDeg = 70) {
    this.out.pipes.push({ p: [r2(p[0] + this.ox), p[1], r2(p[2])], ry, length, radius, color, phi: (phiDeg * Math.PI) / 180 })
  }

  cylinder(p, radius, height, color, opts = {}) {
    this.out.cylinders.push({ p: [r2(p[0] + this.ox), p[1], r2(p[2])], radius, height, color, collide: opts.collide !== false })
  }

  /**
   * Grindable rail from a to b (rail-top points). `posts` draws support posts;
   * `collider` (default = posts) makes it solid so landing on it starts a grind.
   */
  rail(a, b, color = '#d9dde8', opts = {}) {
    const posts = opts.posts !== false
    this.out.rails.push({
      a: [r2(a[0] + this.ox), r2(a[1]), r2(a[2])],
      b: [r2(b[0] + this.ox), r2(b[1]), r2(b[2])],
      color,
      posts,
      collider: opts.collider ?? posts,
    })
  }

  /** A low ledge with a grindable metal coping along its top. */
  ledge(x, zA, zB, h = 0.55, color = this.theme.floorAlt) {
    this.box([x, h / 2, (zA + zB) / 2], [1.4, h, zA - zB], 'stud', color)
    this.rail([x, h + 0.06, zA - 0.3], [x, h + 0.06, zB + 0.3], '#e6e9f2', { posts: false, collider: true })
  }

  prop(kind, p, opts = {}) {
    const spec = PROPS[kind]
    const k = opts.k || 1
    this.out.props.push({
      kind,
      p: [r2(p[0] + this.ox), r2(p[1] || 0), r2(p[2])],
      ry: opts.ry || 0,
      s: spec.s.map((v) => r2(v * k)),
      k,
      color: opts.color || null,
      collide: opts.collide ?? spec.collide,
    })
  }

  water(zA, zB, x0 = -H - 1, x1 = H + 1) {
    this.out.water.push({ p: [r2((x0 + x1) / 2 + this.ox), WATER_Y, r2((zA + zB) / 2)], s: [r2(x1 - x0), r2(zA - zB)] })
  }

  sign(text, p, opts = {}) {
    this.out.signs.push({
      text,
      sub: opts.sub || '',
      p: [r2(p[0] + this.ox), p[1], r2(p[2])],
      ry: opts.ry ?? 0,
      size: opts.size || 3,
      color: opts.color || '#ffffff',
      subColor: opts.subColor || '#3fe8ff',
      outline: opts.outline || '#1b1530',
      tilt: opts.tilt || 0,
    })
  }

  tree(p, scale = 1, collide = true) {
    this.out.trees.push({ p: [r2(p[0] + this.ox), p[1], r2(p[2])], s: r2(scale), collide })
  }

  /** Yellow/black hazard stripe strip along x at z (purely visual). */
  stripe(z, x0 = -H, x1 = H) {
    this.out.stripes.push({ p: [r2((x0 + x1) / 2 + this.ox), 0.02, r2(z)], w: r2(x1 - x0) })
  }

  decor(item) {
    if (item.p) item.p = [r2(item.p[0] + this.ox), item.p[1], r2(item.p[2])]
    if (item.a) item.a = [r2(item.a[0] + this.ox), r2(item.a[1])]
    if (item.b) item.b = [r2(item.b[0] + this.ox), r2(item.b[1])]
    this.out.decor.push(item)
  }

  rect(x0, x1, z0, z1) {
    return { x0: r2(Math.min(x0, x1) + this.ox), x1: r2(Math.max(x0, x1) + this.ox), z0: r2(Math.min(z0, z1)), z1: r2(Math.max(z0, z1)) }
  }
}

/* -------------------------------------------------------------------- lobby */

function buildLobby(b) {
  const w = b.w
  const t = b.theme
  const X = LOBBY_HALF_X
  const ZF = LOBBY_FRONT_Z
  const ZB = LOBBY_BACK_Z
  const depth = ZF - ZB

  // Ground + perimeter walls with pillars and grass caps.
  b.box([0, -0.5, (ZF + ZB) / 2], [2 * X, 1, depth], 'stud', t.floor)
  b.box([-X - 1, WALL_H / 2 - 1, (ZF + ZB) / 2], [2, WALL_H + 2, depth + 4], 'dots', t.wall)
  b.box([X + 1, WALL_H / 2 - 1, (ZF + ZB) / 2], [2, WALL_H + 2, depth + 4], 'dots', t.wall)
  b.box([0, WALL_H / 2 - 1, ZF + 1], [2 * X + 4, WALL_H + 2, 2], 'dots', t.wall)
  const backW = X - H - 1
  for (const s of [-1, 1]) {
    b.box([s * (H + 1 + backW / 2), WALL_H / 2 - 1, ZB - 1], [backW + 2, WALL_H + 2, 2], 'dots', t.wall)
    b.box([s * (X + 3), WALL_H + 0.3, (ZF + ZB) / 2], [6, 0.6, depth + 8], 'stud', t.wallTop, { collide: false })
    b.box([s * (H + 1 + backW / 2), WALL_H + 0.3, ZB - 3], [backW + 4, 0.6, 6], 'stud', t.wallTop, { collide: false })
  }
  b.box([0, WALL_H + 0.3, ZF + 3], [2 * X + 12, 0.6, 6], 'stud', t.wallTop, { collide: false })
  // Pillars along the side walls.
  for (let z = ZB + 10; z < ZF; z += 16) {
    for (const s of [-1, 1]) b.box([s * (X - 0.3), WALL_H / 2, z], [0.9, WALL_H, 1.8], 'dots', t.wallDark)
  }
  b.decor({ kind: 'mural', p: [-X + 0.05, 7, 8], side: 1, w: 14, h: 6, seed: 3 })
  b.decor({ kind: 'mural', p: [X - 0.05, 7, 30], side: -1, w: 10, h: 5, seed: 8 })

  // Corner gardens with trees, bushes and rocks.
  for (const s of [-1, 1]) {
    b.box([s * 41, 0.15, 34], [13, 0.3, 11], 'stud', t.wallTop)
    b.tree([s * 44, 0.3, 36], 1.05)
    b.tree([s * 38.5, 0.3, 37.5], 0.75)
    b.prop('bush', [s * 36, 0.3, 31])
    b.prop('rock', [s * 46, 0.3, 30.5], { k: 0.9 })
    b.prop('rock', [s * 40.5, 0.3, 29.8], { k: 0.6 })
  }

  // Spawn plate.
  b.box([0, 0.12, 22], [9, 0.24, 9], 'plain', w === 0 ? '#8e8aa3' : '#2af5c8')
  b.out.spawn = [b.ox, 0.4, 22]
  b.out.spawnRy = Math.PI

  /* ---- Upgrades: skateboard pads (back-left), raised back tier ---- */
  b.sign('UPGRADES', [-33, 12.5, ZB + 0.6], { sub: 'Upgrade your speed!', size: 3.8 })
  const boards = BOARDS.filter((bd) => bd.world === w)
  const front = boards.slice(0, 5)
  const back = boards.slice(5, 10)
  if (back.length) {
    b.box([-33.25, 0.6, -36], [30.5, 1.2, 8], 'stud', t.floorAlt)
    b.wedge([-33.25, 0, -30.5], [30.5, 1.2, 3], 0, 'stud', t.floorAlt)
  }
  front.forEach((bd, i) => b.out.boardPads.push({ board: bd.id, p: [b.ox - 45.8 + i * 6.2, 0, -23.5] }))
  back.forEach((bd, i) => b.out.boardPads.push({ board: bd.id, p: [b.ox - 45.8 + i * 6.2, 1.2, -36] }))

  /* ---- Treadmills (right): two rows of four ---- */
  b.sign('TREADMILLS', [32, 12.5, ZB + 0.6], { sub: 'Increase your speed automatically!', size: 3.8, subColor: '#ffe14d' })
  LOBBY_TREADMILLS[w].forEach((tm, i) => {
    b.out.treadmills.push({
      id: lobbyTreadmillId(w, i),
      p: [b.ox + 19.5 + (i % 4) * 8.2, 0, i < 4 ? -32 : -16.5],
      mult: tm.mult,
      cost: tm.cost,
      color: tm.color,
      lobby: true,
      world: w,
    })
  })

  /* ---- Charms shop stall (front-left) ---- */
  b.box([-34, 0.8, 23], [12, 1.6, 2.4], 'wood', t.wood)
  for (const [x, z] of [[-39.5, 22], [-28.5, 22], [-39.5, 18], [-28.5, 18]]) b.box([x, 3.4, z], [0.7, 6.8, 0.7], 'wood', t.wood)
  b.box([-34, 0.8, 17.5], [12, 1.6, 1], 'wood', t.wood)
  b.decor({ kind: 'awning', p: [-34, 7, 20], w: 13.5, d: 6.5 })
  b.decor({ kind: 'shopkeeper', p: [-34, 0, 20], ry: 0 })
  b.sign('CHARMS SHOP', [-34, 11.5, 20], { sub: 'Buy Rare Charms!', size: 2.8, subColor: '#ffe14d' })
  b.out.shopRect = b.rect(-41, -27, 24.5, 30)
  b.prop('bench', [-20, 0, 27])
  b.prop('trash', [-24, 0, 27])

  /* ---- Mini skatepark (right-front): quarter pipe, funbox, kicker, ledge ---- */
  b.pipe([43.5, 0, 12], 0, 22, 4.5, t.floorAlt, 72)
  const qpTop = 4.5 * (1 - Math.cos((72 * Math.PI) / 180))
  const qpRun = 4.5 * Math.sin((72 * Math.PI) / 180)
  b.rail([43.5 + qpRun, qpTop + 0.12, 1.5], [43.5 + qpRun, qpTop + 0.12, 22.5], '#f0f2f8', { posts: false, collider: false })
  b.wedge([26, 0, 3], [8, 1.2, 3.5], Math.PI, 'stud', t.accent[2])
  b.box([26, 0.6, 8], [8, 1.2, 6.5], 'stud', t.accent[2])
  b.wedge([26, 0, 13], [8, 1.2, 3.5], 0, 'stud', t.accent[2])
  b.rail([20.5, 0.9, 2], [20.5, 0.9, 14])
  b.rail([31.5, 0.9, 2], [31.5, 0.9, 14])
  b.wedge([13, 0, 6], [5, 0.9, 3.5], -Math.PI / 2, 'stud', t.accent[0])
  b.ledge(-22, 12, -6)
  b.prop('lamp', [-12, 0, 30])
  b.prop('lamp', [12, 0, 30])
  b.prop('lamp', [-12, 0, -10])
  b.prop('lamp', [12, 0, -10])
  b.prop('cone', [8, 0, 18])
  b.prop('cone', [10, 0, 16])

  /* ---- Decoration ---- */
  // Coloured floor zones so each area reads at a glance.
  b.box([-33.25, 0.015, -27], [30.5, 0.03, 12], 'stud', w === 0 ? '#c8b6ff' : '#4a3a8a', { collide: false })
  b.box([31.9, 0.015, -24.2], [33.5, 0.03, 23], 'stud', w === 0 ? '#bfeaff' : '#2a4a7a', { collide: false })
  for (let i = 0; i < 4; i += 1) {
    b.box([19.5 + i * 8.2, 0.025, -24.2], [5.2, 0.03, 22], 'stud', i % 2 ? (w === 0 ? '#a8dcff' : '#25406a') : (w === 0 ? '#d6f1ff' : '#32558a'), { collide: false })
  }
  // Path from the spawn to the stage-1 gate, with arrows.
  b.box([0, 0.02, -9], [8, 0.04, 52], 'stud', t.floorAlt, { collide: false })
  for (const sx of [-1, 1]) b.box([sx * 4.1, 0.03, -9], [0.3, 0.06, 52], 'plain', '#ffd21f', { collide: false })
  for (let k = 0; k < 6; k += 1) b.decor({ kind: 'chevron', p: [0, 0, 12 - k * 9], ry: 0, color: '#ffffff' })

  // Fountain plaza.
  b.box([-11, 0.4, 3], [6.4, 0.8, 6.4], 'stud', '#d8d4ea')
  b.decor({ kind: 'fountain', p: [-11, 0, 3], water: t.water })

  // Planters around the spawn plate.
  for (const sx of [-1, 1]) {
    b.prop('planter', [sx * 7.5, 0, 26.5])
    b.prop('planter', [sx * 7.5, 0, 17.5])
  }

  // Bunting across the lobby and banners on the side walls.
  for (const zz of [-6, 12, 26]) b.decor({ kind: 'bunting', p: [0, 17, zz], w: 2 * X, colors: t.accent })
  for (let zz = ZB + 18; zz < ZF; zz += 16) {
    for (const sx of [-1, 1]) b.decor({ kind: 'banner', p: [sx * (X - 0.25), WALL_H - 4, zz], side: -sx, color: t.accent[(zz + sx + 40) % t.accent.length] })
  }

  // Flag poles flanking the two shop signs.
  for (const fx of [-50 + 2, -16, 15, 48 - 2]) b.decor({ kind: 'flagpole', p: [fx, 0, ZB + 2.5], color: t.accent[Math.abs(fx) % t.accent.length] })

  // Big title over the front wall, facing into the lobby.
  b.sign('+1 SPEED SKATEBOARD ESCAPE', [0, 20.5, ZF - 1], { size: 3.4, ry: Math.PI, color: '#ffffff', sub: 'Become the FASTEST on the server!', subColor: '#ffe14d' })

  /* ---- World portal + leaderboards ---- */
  b.out.portal = { p: [b.ox + 24, 0, 31], r: 4.2, to: w === 0 ? 1 : 0 }
  b.out.leaderboards.push({ kind: 'speed', p: [b.ox - 22, 9.5, ZF - 0.2], ry: Math.PI })
  b.out.leaderboards.push({ kind: 'wins', p: [b.ox - 2, 9.5, ZF - 0.2], ry: Math.PI })
  b.out.leaderboards.push({ kind: 'rebirths', p: [b.ox + 18, 9.5, ZF - 0.2], ry: Math.PI })

  b.out.lobby = {
    spawn: b.out.spawn,
    treadmills: [b.ox + 32, 0.4, -6],
    boards: [b.ox - 33, 0.4, -14],
    shop: [b.ox - 34, 0.4, 33],
  }
}

/* ------------------------------------------------------------------- stages */

function stageContext(w, s) {
  const rec = RECOMMENDED_LEVEL[w][s - 1]
  const vReq = moveSpeedFor(rec, 1)
  const jumpMax = vReq * AIR_TIME
  const d = clamp((s - 1) / (STAGES_PER_WORLD - 1) + (w === 1 ? 0.1 : 0), 0, 1)
  return { rec, vReq, jumpMax, safe: jumpMax * 0.6, d, rng: mulberry32(9973 * (w + 1) + s * 131), stage: s }
}

const pick = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length]

const SEG = {
  /** Plaza: manual pads, ledges, banks, benches and planters. */
  plaza(b, z) {
    const t = b.theme
    b.floor(z, z - 46)
    b.box([-9, 0.15, z - 9], [7, 0.3, 4.5], 'stud', t.accent[1])
    b.box([10, 0.15, z - 17], [7, 0.3, 4.5], 'stud', t.accent[2])
    b.ledge(-12, z - 22, z - 36)
    b.ledge(12, z - 26, z - 40, 0.55, t.accent[4])
    b.wedge([-H + 2.5, 0, z - 30], [10, 1.4, 5], Math.PI / 2, 'stud', t.floorAlt)
    b.wedge([H - 2.5, 0, z - 12], [10, 1.4, 5], -Math.PI / 2, 'stud', t.floorAlt)
    b.prop('planter', [0, 0, z - 28])
    b.tree([0, 0.8, z - 28], 0.5, false)
    b.prop('bench', [-4, 0, z - 40], { ry: Math.PI / 2 })
    b.prop('bench', [5, 0, z - 6], { ry: Math.PI / 2 })
    b.prop('trash', [H - 1.5, 0, z - 22])
    b.prop('lamp', [-H + 1, 0, z - 4])
    b.prop('lamp', [H - 1, 0, z - 44])
    return z - 46
  },

  funbox(b, z, c) {
    const t = b.theme
    b.floor(z, z - 36)
    b.wedge([0, 0, z - 10], [10, 1.4, 4.5], 0, 'stud', t.accent[1])
    b.box([0, 0.7, z - 17.5], [10, 1.4, 10.5], 'stud', t.accent[1])
    b.wedge([0, 0, z - 25], [10, 1.4, 4.5], Math.PI, 'stud', t.accent[1])
    b.rail([-9, 0.85, z - 9], [-9, 0.85, z - 26])
    b.rail([9, 0.85, z - 9], [9, 0.85, z - 26])
    b.ledge(0, z - 14, z - 21, 1.95, t.accent[3])
    if (c.d > 0.3) b.wedge([-13, 0, z - 31], [6, 1, 3], 0, 'stud', t.accent[0])
    b.prop('cone', [-14, 0, z - 4])
    b.prop('cone', [14, 0, z - 4])
    return z - 36
  },

  kickerGap(b, z, c) {
    const t = b.theme
    b.floor(z, z - 15)
    b.wedge([0, 0, z - 12.5], [12, 1.0, 5], 0, 'stud', t.accent[0])
    const gap = r2(Math.min(3 + 3 * c.d, c.safe))
    b.stripe(z - 15 + 0.4)
    b.floor(z - 15 - gap, z - 32 - gap)
    b.stripe(z - 15 - gap - 0.4)
    b.prop('rock', [-H + 3, WATER_Y + 0.4, z - 15 - gap / 2], { k: 1.3 })
    b.prop('rock', [H - 4, WATER_Y + 0.4, z - 15 - gap / 2], { k: 1 })
    return z - 32 - gap
  },

  /** City street: road, curbs with lamps, parked cars and hydrants. */
  street(b, z, c) {
    const t = b.theme
    const len = 64
    b.floor(z, z - len, -H + 4, H - 4, t.road)
    b.floor(z, z - len, -H, -H + 4, t.sidewalk, 'stud', 0.25)
    b.floor(z, z - len, H - 4, H, t.sidewalk, 'stud', 0.25)
    b.decor({ kind: 'lane', a: [0, z], b: [0, z - len], w: 2 * H - 8 })
    for (let zz = z - 8; zz > z - len; zz -= 16) {
      b.prop('lamp', [-H + 1.2, 0.25, zz])
      b.prop('lamp', [H - 1.2, 0.25, zz - 8])
    }
    const lanes = [-H + 6.5, H - 6.5]
    let i = 0
    for (let zz = z - 12; zz > z - len + 6; zz -= 13 + c.rng() * 6) {
      b.prop('car', [lanes[i % 2], 0, zz], { color: pick(t.cars, c.rng) })
      i += 1
    }
    if (c.d > 0.25) {
      for (let k = 0; k < 4; k += 1) b.prop('cone', [-3 + k * 2, 0, z - 34 - (k % 2) * 2])
    }
    b.prop('hydrant', [-H + 3, 0.25, z - 20])
    b.prop('trash', [H - 2.5, 0.25, z - 30])
    return z - len
  },

  /** Cone slalom: every row has one gap, alternating sides. */
  cones(b, z, c) {
    const rows = 4 + Math.round(3 * c.d)
    const len = rows * 7 + 10
    b.floor(z, z - len)
    for (let r = 0; r < rows; r += 1) {
      const zz = z - 6 - r * 7
      const gapX = (r % 2 === 0 ? -1 : 1) * (H - 6 - c.rng() * 4)
      for (let x = -H + 0.8; x <= H - 0.8; x += 1.2) {
        if (Math.abs(x - gapX) < 3.2) continue
        b.prop('cone', [x, 0, zz])
      }
    }
    return z - len
  },

  stairs(b, z, c) {
    const t = b.theme
    const h = 2.6
    b.floor(z, z - 36)
    b.wedge([0, 0, z - 4.5], [2 * H, h, 9], 0, 'stud', t.floorAlt)
    b.box([0, h / 2, z - 12], [2 * H, h, 6], 'stud', t.floorAlt)
    stairSet(b, z - 15, h, 0, 7, t.floorAlt)
    for (const x of c.d > 0.5 ? [-4, 4] : [-5, 5]) b.rail([x, h + 0.85, z - 14.6], [x, 0.85, z - 22.4])
    b.ledge(-13, z - 9.5, z - 14.5, h + 0.55, t.accent[2])
    b.prop('planter', [12, h, z - 12])
    return z - 36
  },

  /** Two stair sets with a landing in between, rails on both. */
  bigStairs(b, z) {
    const t = b.theme
    const h = 4.4
    const mid = 2.2
    b.floor(z, z - 52)
    b.wedge([0, 0, z - 8], [2 * H, h, 16], 0, 'stud', t.floorAlt)
    b.box([0, h / 2, z - 19], [2 * H, h, 6], 'stud', t.floorAlt)
    stairSet(b, z - 22, h, mid, 6, t.floorAlt)
    b.box([0, mid / 2, z - 31], [2 * H, mid, 6], 'stud', t.floorAlt)
    stairSet(b, z - 34, mid, 0, 6, t.floorAlt)
    for (const x of [-6, 6]) {
      b.rail([x, h + 0.85, z - 21.6], [x, mid + 0.85, z - 28.4])
      b.rail([x, mid + 0.85, z - 33.6], [x, 0.85, z - 40.4])
    }
    b.rail([0, h + 0.9, z - 21.6], [0, 0.9, z - 40.4])
    b.prop('lamp', [-H + 1, h, z - 18])
    b.prop('lamp', [H - 1, mid, z - 30])
    return z - 52
  },

  narrowRoad(b, z, c) {
    const t = b.theme
    const width = r2(Math.max(5, 10 - 5 * c.d))
    const a = r2(Math.min(H - width / 2 - 1, 5 + 5 * c.d))
    b.floor(z, z - 6)
    const pts = [[0, z - 5], [0, z - 14], [a, z - 26], [a, z - 36], [-a, z - 52], [-a, z - 60], [0, z - 70], [0, z - 74]]
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [x0, z0] = pts[i]
      const [x1, z1] = pts[i + 1]
      const len = Math.hypot(x1 - x0, z1 - z0)
      const ry = Math.atan2(x1 - x0, z1 - z0)
      b.box([(x0 + x1) / 2, -0.5, (z0 + z1) / 2], [width, 1, len + width * 0.5], 'stud', t.road, { ry })
      b.box([x1, -0.5, z1], [width, 1, width], 'stud', t.road, { ry })
      b.decor({ kind: 'lane', a: [x0, z0], b: [x1, z1], w: width })
    }
    b.prop('rock', [-H + 4, WATER_Y + 0.3, z - 30], { k: 1.6 })
    b.prop('rock', [H - 3, WATER_Y + 0.3, z - 58], { k: 1.3 })
    b.floor(z - 73, z - 82)
    return z - 82
  },

  granny(b, z, c) {
    b.floor(z, z - 44)
    const speed = r2(3 + 4 * c.d)
    b.out.obstacles.push({ id: `g${b.w}_${Math.round(-z)}`, kind: 'granny', x0: b.ox - (H - 5), x1: b.ox + (H - 5), z: z - 18, speed, phase: r2(c.rng()) })
    if (c.d > 0.45) {
      b.out.obstacles.push({ id: `g${b.w}_${Math.round(-z)}b`, kind: 'granny', x0: b.ox - (H - 5), x1: b.ox + (H - 5), z: z - 33, speed: r2(speed * 0.85), phase: r2(c.rng() + 0.5) })
    }
    b.prop('bench', [-H + 1.5, 0, z - 8], { ry: Math.PI / 2 })
    b.prop('bench', [H - 1.5, 0, z - 40], { ry: Math.PI / 2 })
    b.sign('GRANNY CROSSING', [0, 12, z - 3], { size: 1.8, color: '#ffe14d' })
    return z - 44
  },

  sweepers(b, z, c) {
    const two = c.d > 0.5
    const len = two ? 54 : 32
    b.floor(z, z - len)
    const spin = r2(0.55 + 0.55 * c.d)
    const centres = two ? [z - 15, z - 39] : [z - 16]
    centres.forEach((zc, i) => {
      b.cylinder([0, 0, zc], 1.2, 2.4, '#ffd21f')
      b.out.obstacles.push({ id: `sw${b.w}_${Math.round(-zc)}`, kind: 'sweeper', p: [b.ox, 0.55, zc], radius: H - 1.4, spin: i % 2 ? -spin : spin, phase: r2(c.rng() * Math.PI * 2) })
    })
    return z - len
  },

  stones(b, z, c) {
    const t = b.theme
    const n = 5 + Math.round(3 * c.d)
    const ps = r2(6 - 1.5 * c.d)
    const gz = r2(Math.min(2 + 2.5 * c.d, c.safe * 0.85))
    const xo = r2(Math.min(3 + 4 * c.d, (ps + 0.6 * gz) / 2))
    b.floor(z, z - 6)
    let cz = z - 6
    for (let i = 0; i < n; i += 1) {
      cz -= gz
      const x = i % 2 === 0 ? xo : -xo
      b.box([x, -0.5, cz - ps / 2], [ps, 1, ps], 'stud', t.accent[i % t.accent.length])
      b.box([x, -2, cz - ps / 2], [ps * 0.5, 2, ps * 0.5], 'stud', t.rock, { collide: false })
      cz -= ps
    }
    cz -= gz
    b.prop('rock', [-H + 3, WATER_Y + 0.4, z - 14], { k: 1.5 })
    b.prop('rock', [H - 3, WATER_Y + 0.4, cz + 8], { k: 1.2 })
    b.floor(cz, cz - 10)
    return cz - 10
  },

  railBridge(b, z, c) {
    const t = b.theme
    b.floor(z, z - 8)
    const gap = 16
    const bw = r2(Math.max(1.6, 3 - 1.2 * c.d))
    b.box([-5, -0.5, z - 8 - gap / 2], [bw, 1, gap + 0.6], 'wood', t.wood)
    b.rail([4, 0.9, z - 5], [4, 0.9, z - 8 - gap - 3])
    if (c.d > 0.45) b.rail([10, 1.6, z - 5], [10, 0.9, z - 8 - gap - 3])
    b.stripe(z - 8 + 0.4)
    b.prop('rock', [-H + 4, WATER_Y + 0.4, z - 16], { k: 1.4 })
    b.floor(z - 8 - gap, z - 22 - gap)
    return z - 22 - gap
  },

  halfPipe(b, z, c) {
    const t = b.theme
    const R = 5.5
    const phi = (70 * Math.PI) / 180
    const run = R * Math.sin(phi)
    const top = R * (1 - Math.cos(phi))
    b.floor(z, z - 40)
    for (const s of [-1, 1]) {
      b.pipe([s * 6, 0, z - 20], s > 0 ? 0 : Math.PI, 36, R, t.floorAlt)
      const deckW = H - 6 - run
      b.box([s * (6 + run + deckW / 2), top / 2, z - 20], [deckW, top, 36], 'stud', t.floorAlt)
      b.rail([s * (6 + run), top + 0.12, z - 3], [s * (6 + run), top + 0.12, z - 37], '#f0f2f8', { posts: false, collider: false })
    }
    if (c.d > 0.6) {
      b.out.obstacles.push({ id: `sw${b.w}_${Math.round(-z)}hp`, kind: 'sweeper', p: [b.ox, 0.55, z - 20], radius: 5.6, spin: 1.4, phase: r2(c.rng() * 6) })
      b.cylinder([0, 0, z - 20], 0.8, 2, '#ffd21f')
    }
    return z - 40
  },

  /** Bowl: pipes on both sides and a pyramid in the middle with hips. */
  bowl(b, z, c) {
    const t = b.theme
    const len = 46
    const R = 5
    b.floor(z, z - len)
    const run = R * Math.sin((70 * Math.PI) / 180)
    const top = R * (1 - Math.cos((70 * Math.PI) / 180))
    for (const s of [-1, 1]) {
      b.pipe([s * 9, 0, z - len / 2], s > 0 ? 0 : Math.PI, len - 4, R, t.accent[3])
      const deckW = H - 9 - run
      b.box([s * (9 + run + deckW / 2), top / 2, z - len / 2], [deckW, top, len - 4], 'stud', t.floorAlt)
    }
    // Pyramid.
    const pz = z - len / 2
    b.box([0, 0.75, pz], [5, 1.5, 5], 'stud', t.accent[1])
    b.wedge([0, 0, pz + 4.5], [5, 1.5, 4], 0, 'stud', t.accent[1])
    b.wedge([0, 0, pz - 4.5], [5, 1.5, 4], Math.PI, 'stud', t.accent[1])
    b.wedge([4.5, 0, pz], [5, 1.5, 4], Math.PI / 2, 'stud', t.accent[1])
    b.wedge([-4.5, 0, pz], [5, 1.5, 4], -Math.PI / 2, 'stud', t.accent[1])
    b.rail([0, 1.95, pz + 2], [0, 1.95, pz - 2], '#ffffff', { posts: false, collider: true })
    if (c.d > 0.35) {
      b.out.obstacles.push({ id: `g${b.w}_${Math.round(-z)}bw`, kind: 'granny', x0: b.ox - 6, x1: b.ox + 6, z: z - 8, speed: r2(2.5 + 3 * c.d), phase: r2(c.rng()) })
    }
    return z - len
  },

  /** Construction site: crate stacks to weave through, ramps onto them, barrels. */
  crates(b, z, c) {
    const t = b.theme
    const len = 52
    b.floor(z, z - len, -H, H, t.sidewalk)
    const rows = [z - 10, z - 24, z - 38]
    rows.forEach((rz, i) => {
      const gap = (i % 2 === 0 ? 1 : -1) * (6 + c.rng() * 4)
      for (let x = -H + 2; x <= H - 2; x += 4) {
        if (Math.abs(x - gap) < 4) continue
        const tall = c.rng() < 0.35
        b.box([x, 1, rz], [3.6, 2, 3.6], 'wood', t.wood)
        if (tall) b.box([x, 3, rz], [3, 2, 3], 'wood', t.wood)
      }
      // Ramp onto the crates for the brave.
      b.wedge([-gap * 0.6, 0, rz + 4.2], [4, 2, 5], 0, 'stud', t.accent[0])
      b.prop('barrel', [gap + 3.5, 0, rz - 4], { color: '#ff7a1f' })
      b.prop('barrel', [gap - 3.5, 0, rz + 4], { color: '#3b7bff' })
    })
    b.prop('cone', [-2, 0, z - 4])
    b.prop('cone', [2, 0, z - 4])
    b.sign('HARD HAT AREA', [0, 12, z - 2], { size: 1.6, color: '#ffd21f' })
    return z - len
  },

  /** Mega ramp: climb, drop in to build speed, launch over the water. */
  megaRamp(b, z, c) {
    const t = b.theme
    const h = 6
    b.floor(z, z - 6)
    b.wedge([0, 0, z - 17], [2 * H, h, 22], 0, 'stud', t.floorAlt)
    b.box([0, h / 2, z - 32], [2 * H, h, 8], 'stud', t.floorAlt)
    b.wedge([0, 0, z - 43], [2 * H, h, 14], Math.PI, 'stud', t.accent[3])
    b.floor(z - 36, z - 64)
    b.wedge([0, 0, z - 61.5], [14, 1.4, 5], 0, 'stud', t.accent[0])
    const gap = r2(Math.min(c.jumpMax * 0.8, 4 + 6 * c.d))
    b.stripe(z - 64 + 0.4)
    b.floor(z - 64 - gap, z - 80 - gap)
    b.sign('MEGA RAMP', [0, h + 7, z - 30], { size: 2.6, color: '#ff7ad9' })
    for (const s of [-1, 1]) b.rail([s * (H - 1.2), h + 0.9, z - 28.4], [s * (H - 1.2), h + 0.9, z - 35.6])
    return z - 80 - gap
  },

  movers(b, z, c) {
    const n = c.d > 0.6 ? 3 : 2
    const gz = r2(Math.min(2.5 + 1.5 * c.d, c.safe * 0.7))
    const depth = 6
    b.floor(z, z - 6)
    let cz = z - 6
    for (let i = 0; i < n; i += 1) {
      cz -= gz
      b.out.movers.push({
        id: `mv${b.w}_${Math.round(-cz)}`,
        p: [b.ox, -0.5, r2(cz - depth / 2)],
        s: [8, 1, depth],
        amp: r2(6 + 4 * c.d),
        period: r2(5.5 - 1.5 * c.d),
        phase: r2(i * 0.37 + c.rng() * 0.2),
        color: b.theme.accent[(i + 2) % b.theme.accent.length],
      })
      cz -= depth
    }
    cz -= gz
    b.floor(cz, cz - 10)
    return cz - 10
  },
}

/** Visual steps over an invisible smooth ramp (so riding down is smooth). */
function stairSet(b, zTop, hTop, hBottom, run, color) {
  const steps = Math.max(2, Math.round((hTop - hBottom) / 0.42))
  for (let i = 0; i < steps; i += 1) {
    const top = hTop - ((i + 1) * (hTop - hBottom)) / steps
    if (top <= 0.001) continue
    b.box([0, top / 2, zTop - (i + 0.5) * (run / steps)], [2 * H, top, run / steps], 'stud', color, { collide: false })
  }
  b.wedge([0, hBottom, zTop - run / 2], [2 * H, hTop - hBottom, run], Math.PI, 'stud', color, { visible: false })
}

/** Each stage is a themed adventure. World 2 remixes them under neon lights. */
const PLANS = [
  ['plaza', 'funbox', 'kickerGap'],
  ['street', 'stairs', 'bigStairs'],
  ['street', 'granny', 'cones'],
  ['plaza', 'railBridge', 'stones', 'railBridge'],
  ['halfPipe', 'bowl', 'kickerGap'],
  ['crates', 'sweepers', 'movers'],
  ['megaRamp', 'bigStairs', 'granny'],
  ['stones', 'movers', 'railBridge', 'narrowRoad'],
  ['halfPipe', 'sweepers', 'bowl', 'movers'],
  ['street', 'granny', 'crates', 'megaRamp', 'sweepers', 'stones'],
]
const PLANS_W2 = [
  ['street', 'cones', 'granny'],
  ['bigStairs', 'stairs', 'kickerGap'],
  ['bowl', 'halfPipe', 'sweepers'],
  ['railBridge', 'narrowRoad', 'railBridge'],
  ['street', 'granny', 'cones', 'granny'],
  ['crates', 'movers', 'sweepers', 'crates'],
  ['megaRamp', 'stones', 'megaRamp'],
  ['narrowRoad', 'movers', 'stones', 'railBridge'],
  ['halfPipe', 'bowl', 'sweepers', 'movers'],
  ['megaRamp', 'crates', 'granny', 'bigStairs', 'movers', 'stones'],
]

function buildStage(b, s, zStart) {
  const w = b.w
  const t = b.theme
  const c = stageContext(w, s)
  const isLast = s === STAGES_PER_WORLD
  const name = STAGE_NAMES[w][s - 1]
  let z = zStart

  // Start section + arch.
  b.floor(z, z - 18)
  b.decor({ kind: 'arch', p: [0, 0, z], w: 2 * H, color: t.accent[s % t.accent.length] })
  b.sign(`STAGE ${s + w * STAGES_PER_WORLD}`, [0, 11.2, z - 0.7], { sub: `${name}  ·  Recommended Level: ${c.rec}`, size: 4 })
  const startRect = b.rect(-H, H, z - 18, z)
  const spawn = [b.ox, 0.4, r2(z - 8)]
  for (const sx of [-1, 1]) {
    b.prop('planter', [sx * (H - 2), 0, z - 4])
    b.prop('planter', [sx * (H - 2), 0, z - 14])
    b.prop('cone', [sx * 6, 0, z - 15])
  }
  for (let k = 0; k < 3; k += 1) b.decor({ kind: 'chevron', p: [0, 0, z - 4 - k * 4], ry: 0, color: '#ffffff' })
  z -= 18

  const plan = (w === 0 ? PLANS : PLANS_W2)[s - 1]
  for (const seg of plan) z = SEG[seg](b, z, c)

  // Speed gap: sized so the recommended level clears it with a little room.
  const gapStart = z
  const gap = r2(Math.max(3, c.vReq * AIR_TIME * 0.92))
  b.stripe(z + 0.4)
  b.sign('SPEED GAP', [0, 6, z - gap / 2], { sub: `Level ${c.rec}+`, size: 2.4, color: '#ffe14d', subColor: '#ffffff' })
  z -= gap
  b.stripe(z - 0.4)

  // Finish platform. The middle lane stays clear so you can ride straight
  // through the next stage's gate; either side of the gate has a win pad on a
  // glowing plinth with a training treadmill beside it.
  const endStart = z
  const FIN = 36
  b.floor(z, z - FIN, -H, H, t.floor)
  b.box([0, 0.015, z - FIN / 2 + 2], [9, 0.03, FIN - 6], 'plain', t.floorAlt, { collide: false })
  // Checkered finish line just before the gate.
  for (let row = 0; row < 2; row += 1) {
    for (let i = 0; i < 18; i += 1) {
      b.box([-H + (i + 0.5) * ((2 * H) / 18), 0.025, z - FIN + 1.6 + row * 1.0], [(2 * H) / 18, 0.05, 1], 'plain', (i + row) % 2 ? '#ffffff' : '#1b1530', { collide: false })
    }
  }
  const padZ = r2(z - FIN + 6.5)
  const wins = STAGE_WINS[w][s - 1]
  // Left = FREE (win & continue, free treadmill). Right = PREMIUM, unlocked once
  // with Wins: triple wins (then back to the lobby) and a much faster treadmill.
  const sides = [
    { sx: -1, kind: isLast ? 'return' : 'continue', id: `w${w}_${s}_c`, tm: 0, premium: false },
    { sx: 1, kind: 'return', id: `w${w}_${s}_p`, tm: 1, premium: true },
  ]
  for (const side of sides) {
    const padX = side.sx * 9.6
    const tmX = side.sx * 15
    const glow = side.premium ? '#ffc21f' : '#38f05a'
    // Plinth under pad + treadmill, with a coloured trim.
    b.box([side.sx * 12.1, 0.06, padZ], [11.2, 0.12, 9], 'stud', t.floorAlt, { collide: false })
    b.box([side.sx * 12.1, 0.02, padZ + 4.6], [11.2, 0.04, 0.3], 'plain', glow, { collide: false })
    b.out.winPads.push({
      id: side.id,
      stage: s,
      world: w,
      kind: side.kind,
      p: [b.ox + padX, 0, padZ],
      s: [6.5, 5],
      wins: side.premium ? wins * PREMIUM_PAD_MULT : wins,
      premium: side.premium,
      cost: side.premium ? premiumPadCost(w, s) : 0,
    })
    b.out.treadmills.push({
      id: stageTreadmillId(w, s, side.tm),
      p: [b.ox + tmX, 0, padZ],
      mult: stageTreadmillMult(w, s, side.tm),
      cost: side.premium ? premiumTreadmillCost(w, s) : 0,
      premium: side.premium,
      color: side.tm === 0 ? t.accent[(s + 1) % 6] : t.accent[(s + 3) % 6],
      lobby: false,
      world: w,
      stage: s,
    })
    // Floor arrows leading from the lane to the pad.
    for (let k = 0; k < 3; k += 1) {
      b.decor({ kind: 'chevron', p: [side.sx * (2.2 + k * 2.2), 0, padZ + 7.5 - k * 0.9], ry: side.sx > 0 ? -Math.PI / 2 + 0.35 : Math.PI / 2 - 0.35, color: glow })
    }
    b.sign(side.premium ? 'VIP SIDE' : 'FREE SIDE', [side.sx * 12.1, 8.6, padZ - 3.5], {
      size: 1.6,
      color: glow,
      sub: side.premium ? 'x3 Wins + Super Treadmill' : 'Free Wins + Treadmill',
      subColor: '#ffffff',
    })
    b.prop('planter', [side.sx * (H - 2), 0, z - 5])
    b.prop('lamp', [side.sx * (H - 1), 0, z - 12])
  }
  // Centre arrows point at the gate.
  for (let k = 0; k < 5; k += 1) b.decor({ kind: 'chevron', p: [0, 0, z - 4 - k * 4.5], ry: 0, color: '#ffffff' })
  z -= 36

  if (isLast) {
    b.box([0, WALL_H / 2 - 1, z - 1], [2 * H + 4, WALL_H + 2, 2], 'dots', t.wall)
    b.sign('YOU ESCAPED!', [0, 11, z + 0.2], { sub: b.w === 0 ? 'World 2 awaits...' : 'Legend of the park!', size: 4.5, color: '#ffe14d', subColor: '#ffffff' })
  }

  // Canyon walls with pillars, murals, grass caps; water underneath.
  const len = zStart - z
  const zc = (zStart + z) / 2
  for (const side of [-1, 1]) {
    b.box([side * (H + 1), (WALL_H + WATER_Y) / 2 - 0.5, zc], [2, WALL_H - WATER_Y + 1, len], 'dots', t.wall)
    b.box([side * (H + 5), WALL_H + 0.3, zc], [8, 0.6, len], 'stud', t.wallTop, { collide: false })
    b.box([side * (H + 0.08), WALL_H - 0.6, zc], [0.3, 1.2, len], 'stud', t.wallTop, { collide: false })
  }
  for (let zz = zStart - 9; zz > z + 4; zz -= 18) {
    for (const side of [-1, 1]) b.box([side * (H - 0.35), (WALL_H + WATER_Y) / 2 - 0.5, zz], [0.9, WALL_H - WATER_Y + 1, 2], 'dots', t.wallDark)
  }
  let muralSide = 1
  for (let zz = zStart - 30; zz > z + 20; zz -= 46 + c.rng() * 30) {
    b.decor({ kind: 'mural', p: [muralSide * (H - 0.75), 6 + c.rng() * 3, zz], side: -muralSide, w: 9 + c.rng() * 6, h: 4 + c.rng() * 2, seed: Math.floor(c.rng() * 1000) })
    muralSide = -muralSide
  }
  // Bunting strung across the canyon and banners hanging off the wall tops.
  for (let zz = zStart - 22; zz > z + 10; zz -= 28) {
    b.decor({ kind: 'bunting', p: [0, WALL_H - 3.5, zz], w: 2 * H, colors: t.accent })
  }
  let bannerI = 0
  for (let zz = zStart - 18; zz > z + 6; zz -= 36) {
    for (const side of [-1, 1]) {
      b.decor({ kind: 'banner', p: [side * (H - 0.25), WALL_H - 4, zz], side: -side, color: t.accent[(s + bannerI) % t.accent.length] })
      bannerI += 1
    }
  }
  b.water(zStart, z)

  // Houses, trees, bushes and rocks on the canyon rim (seeded, decorative).
  for (let zz = zStart - 6; zz > z + 6; zz -= 12 + c.rng() * 8) {
    for (const side of [-1, 1]) {
      const r = c.rng()
      if (r < 0.45) {
        const hw = 6 + c.rng() * 6
        const hh = 5 + c.rng() * 9
        b.decor({
          kind: 'house',
          p: [side * (H + 6 + hw / 2 + c.rng() * 4), WALL_H, r2(zz)],
          s: [r2(hw), r2(hh), r2(6 + c.rng() * 6)],
          color: t.houses[Math.floor(c.rng() * t.houses.length)],
        })
      } else if (r < 0.8) {
        b.tree([side * (H + 6 + c.rng() * 6), WALL_H, r2(zz)], 0.8 + c.rng() * 0.45, false)
        b.prop('bush', [side * (H + 3 + c.rng() * 2), WALL_H, r2(zz + 3)], { k: 0.9 })
      } else {
        b.prop('rock', [side * (H + 4 + c.rng() * 6), WALL_H, r2(zz)], { k: 1 + c.rng() })
      }
    }
  }

  b.out.stages.push({
    world: w,
    stage: s,
    name,
    rec: c.rec,
    zStart,
    zEnd: z,
    startRect,
    spawn,
    gapStart,
    gap,
    endStart,
    endRect: b.rect(-H, H, endStart - 36, endStart),
    wins,
  })
  return z
}

/** Builds one world. Pure function of `w`. */
export function buildWorld(w) {
  const b = new Builder(w)
  buildLobby(b)
  let z = LOBBY_BACK_Z
  for (let s = 1; s <= STAGES_PER_WORLD; s += 1) z = buildStage(b, s, z)
  b.out.length = -z
  return b.out
}

let cache = null
/** All worlds, memoised. */
export function getWorlds() {
  if (!cache) cache = Array.from({ length: WORLD_COUNT }, (_, w) => buildWorld(w))
  return cache
}

export const inRect = (r, x, z, pad = 0) => x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad

/** Which world an x-coordinate belongs to. */
export const worldOfX = (x) => clamp(Math.round(x / WORLD_SPACING), 0, WORLD_COUNT - 1)

/** Stage (1-based) whose z-range contains z, or 0 for the lobby. */
export function stageAtZ(layout, z) {
  if (z > LOBBY_BACK_Z) return 0
  for (const st of layout.stages) if (z <= st.zStart && z > st.zEnd) return st.stage
  return STAGES_PER_WORLD
}

/** Every buyable stage item (premium pads + premium treadmills) by id. */
let premiumIndex = null
export function premiumItem(id) {
  if (!premiumIndex) {
    premiumIndex = new Map()
    for (const l of getWorlds()) {
      for (const p of l.winPads) if (p.premium) premiumIndex.set(p.id, { kind: 'pad', item: p })
      for (const tm of l.treadmills) if (tm.premium) premiumIndex.set(tm.id, { kind: 'treadmill', item: tm })
    }
  }
  return premiumIndex.get(String(id)) || null
}

export function treadmillAt(layout, x, y, z) {
  for (const tm of layout.treadmills) {
    if (Math.abs(x - tm.p[0]) <= TREADMILL_HALF.x && Math.abs(z - tm.p[2]) <= TREADMILL_HALF.z && y > tm.p[1] - 0.5 && y < tm.p[1] + 3) {
      return tm
    }
  }
  return null
}

export function winPadAt(layout, x, y, z) {
  for (const pad of layout.winPads) {
    if (Math.abs(x - pad.p[0]) <= pad.s[0] / 2 + 0.4 && Math.abs(z - pad.p[2]) <= pad.s[1] / 2 + 0.4 && y < 3) return pad
  }
  return null
}

/* ---------------------------------------------- deterministic moving things */

/** Granny position at time t (seconds, server clock). */
export function grannyPos(o, t) {
  const span = o.x1 - o.x0
  const period = (2 * span) / o.speed
  const u = (((t / period + o.phase) % 1) + 1) % 1
  const goingRight = u < 0.5
  const x = goingRight ? o.x0 + span * (u * 2) : o.x1 - span * ((u - 0.5) * 2)
  return { x, z: o.z, facing: goingRight ? 1 : -1, walk: t * o.speed * 0.9 }
}

export function sweeperAngle(o, t) {
  return o.phase + o.spin * t
}

export function moverPos(m, t) {
  const x = m.p[0] + Math.sin(((t / m.period + m.phase) % 1) * Math.PI * 2) * m.amp
  return [x, m.p[1], m.p[2]]
}
