/**
 * Deterministic map generator: one lobby + 15 Sunny Skatepark stages and
 * 10 Neon City stages.
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
 *
 * Rules that keep the map free of flicker (z-fighting)
 *  - Two upward-facing surfaces never share the same height where they overlap.
 *    Pieces of a segment abut edge-to-edge; they never overlap.
 *  - Floor markings are `decal`s: thin plates that float DECAL_LIFT above the
 *    surface and render with a polygon offset.
 *  - Curved / sloped roads are one continuous `ribbon` mesh instead of rotated
 *    boxes overlapping at the bends.
 */

import {
  AIR_TIME,
  BOARDS,
  LOBBY_TREADMILLS,
  PREMIUM_PAD_MULT,
  RECOMMENDED_LEVEL,
  STAGE_NAMES,
  STAGE_WINS,
  WORLD_COUNT,
  lobbyTreadmillId,
  moveSpeedFor,
  premiumPadCost,
  premiumTreadmillCost,
  stageCount,
  stageNumber,
  stageTreadmillId,
  stageTreadmillMult,
} from './config.js'

export const WORLD_SPACING = 4000
export const TRACK_HALF = 18
export const WALL_H = 16
export const WATER_Y = -3
export const KILL_Y = -1.6
export const LOBBY_HALF_X = 40
export const LOBBY_FRONT_Z = 36
export const LOBBY_BACK_Z = -40
export const TREADMILL_HALF = { x: 1.8, z: 3.4 }
export const BOARD_PAD = { x: 4.6, z: 4.0 }
/** How far floor markings float above the surface they sit on. */
export const DECAL_LIFT = 0.035

export const THEMES = [
  {
    floor: '#cfcddb',
    floorAlt: '#aaa6bf',
    wall: '#d57a32',
    wallDark: '#a85a24',
    wallTop: '#4fd83b',
    grassDark: '#33b52e',
    road: '#2c3456',
    sidewalk: '#b3afc2',
    water: '#3ec8f5',
    wood: '#b8783f',
    metal: '#9aa2b4',
    trunk: '#7a4b2a',
    leaf: '#46d040',
    leafDark: '#2fa832',
    leafLight: '#8cf25e',
    rock: '#9a94a8',
    accent: ['#ff4d5e', '#ffd21f', '#35d6ff', '#9a5cff', '#ff7ad9', '#4fe36b'],
    houses: ['#ff7aa8', '#ffd45c', '#7ad8ff', '#a98bff', '#8cff9e', '#ff9d5c'],
    cars: ['#ff3b3b', '#3b7bff', '#ffd21f', '#38d05a', '#ffffff', '#ff8a1f'],
    sky: ['#1a72ff', '#8fd0ff'],
    fog: '#a8dcff',
    sun: '#fff3dc',
  },
  {
    floor: '#3c4060',
    floorAlt: '#33374f',
    wall: '#5a3fb0',
    wallDark: '#42298c',
    wallTop: '#2af5c8',
    grassDark: '#1fbf98',
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
  lily: { s: [1.2, 0.05, 1.2], collide: false },
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

/**
 * Samples a smooth path (Catmull-Rom through the control points) for a ribbon.
 * Returns points with a unit horizontal tangent; shared by the client renderer
 * and the physics builder so the mesh and its collider are identical.
 */
export function sampleRibbon(pts, perSegment = 8) {
  const P = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))]
  const out = []
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = P(i - 1)
    const p1 = P(i)
    const p2 = P(i + 1)
    const p3 = P(i + 2)
    const steps = i === pts.length - 2 ? perSegment + 1 : perSegment
    for (let k = 0; k < steps; k += 1) {
      const t = k / perSegment
      const t2 = t * t
      const t3 = t2 * t
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]), cr(p0[2], p1[2], p2[2], p3[2])])
    }
  }
  return out.map((p, i) => {
    const a = out[Math.max(0, i - 1)]
    const b = out[Math.min(out.length - 1, i + 1)]
    let tx = b[0] - a[0]
    let tz = b[2] - a[2]
    const len = Math.hypot(tx, tz) || 1
    tx /= len
    tz /= len
    return { x: p[0], y: p[1], z: p[2], tx, tz }
  })
}

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
      ribbons: [],
      crumbles: [],
      water: [],
      winPads: [],
      treadmills: [],
      boardPads: [],
      obstacles: [],
      movers: [],
      signs: [],
      trees: [],
      props: [],
      stages: [],
      leaderboards: [],
      decor: [],
      spawn: null,
      spawnRy: Math.PI,
      lobby: null,
      portal: null,
      shopRect: null,
      shop: null,
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

  /**
   * Floor marking: a thin plate floating just above a surface at height `top`.
   * Markings painted over other markings use a higher `layer`.
   */
  decal(x, z, w, l, color, ry = 0, top = 0, layer = 0) {
    this.box([x, top + DECAL_LIFT * (1 + layer), z], [w, 0.03, l], 'decal', color, { ry, collide: false })
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

  /**
   * One continuous road/bridge mesh along a smooth path. `pts` are [x, y, z]
   * control points (y = the road's top). `curb` adds raised edges, `pillars`
   * drops supports into the river.
   */
  ribbon(pts, opts = {}) {
    const r = {
      pts: pts.map(([x, y, z]) => [r2(x + this.ox), r2(y), r2(z)]),
      w: opts.w || 10,
      thick: opts.thick || 1,
      color: opts.color || this.theme.road,
      edge: opts.edge || this.theme.sidewalk,
      mat: opts.mat || 'stud',
      curb: !!opts.curb,
      lane: opts.lane !== false,
    }
    this.out.ribbons.push(r)
    if (opts.pillars) {
      const samples = sampleRibbon(r.pts)
      for (let i = 4; i < samples.length - 4; i += 8) {
        const s = samples[i]
        const h = s.y - r.thick - (WATER_Y - 1)
        this.out.cylinders.push({ p: [r2(s.x), WATER_Y - 1, r2(s.z)], radius: 0.7, height: r2(h), color: this.theme.floorAlt, collide: false })
      }
    }
    return r
  }

  /** A plank that shakes and drops into the river when ridden over. */
  crumble(p, s, color = this.theme.wood) {
    this.out.crumbles.push({ id: `c${this.w}_${this.out.crumbles.length}`, p: [r2(p[0] + this.ox), r2(p[1]), r2(p[2])], s, color })
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

  /** Yellow/black hazard stripe across the track at z. */
  stripe(z, x0 = -H, x1 = H) {
    const n = Math.round((x1 - x0) / 1.2)
    for (let i = 0; i < n; i += 1) {
      this.decal(x0 + (i + 0.5) * ((x1 - x0) / n), z, (x1 - x0) / n, 0.8, i % 2 ? '#1b1b22' : '#ffd21f', 0, 0, 1)
    }
  }

  /** ">" arrow painted on the floor, pointing along local -Z of `ry`. */
  chevron(x, z, ry = 0, color = '#ffffff', top = 0) {
    const c = Math.cos(ry)
    const sn = Math.sin(ry)
    for (const arm of [-1, 1]) {
      const ox = arm * 0.55
      const oz = 0.45
      this.decal(x + ox * c + oz * sn, z - ox * sn + oz * c, 0.32, 1.5, color, ry + arm * 0.75, top, 1)
    }
  }

  /** Dashed centre line between two points. */
  laneLine(x0, z0, x1, z1, top = 0) {
    const len = Math.hypot(x1 - x0, z1 - z0)
    const ry = Math.atan2(x1 - x0, z1 - z0)
    const dashes = Math.floor(len / 3)
    for (let i = 0; i < dashes; i += 1) {
      const u = (i + 0.5) / dashes
      this.decal(x0 + (x1 - x0) * u, z0 + (z1 - z0) * u, 0.35, 1.4, '#ffd21f', ry, top, 1)
    }
  }

  decor(item) {
    if (item.p) item.p = [r2(item.p[0] + this.ox), item.p[1], r2(item.p[2])]
    this.out.decor.push(item)
  }

  rect(x0, x1, z0, z1) {
    return { x0: r2(Math.min(x0, x1) + this.ox), x1: r2(Math.max(x0, x1) + this.ox), z0: r2(Math.min(z0, z1)), z1: r2(Math.max(z0, z1)) }
  }

  /**
   * Earth cliff (dirt with darker strata and a grassy lip) between z0 and z1 at
   * x = side * xIn (inner face). Top at WALL_H, bottom below the river.
   */
  cliff(side, xIn, zA, zB, bottom = WATER_Y - 2) {
    const t = this.theme
    const len = zA - zB
    const zc = (zA + zB) / 2
    const hgt = WALL_H - bottom
    this.box([side * (xIn + 3), bottom + hgt / 2, zc], [6, hgt, len], 'dirt', t.wall)
    // Grass on top, overhanging the edge a little, and a darker grass lip.
    this.box([side * (xIn + 4.6), WALL_H + 0.35, zc], [9.4, 0.7, len], 'stud', t.wallTop, { collide: false })
    this.box([side * (xIn - 0.15), WALL_H + 0.1, zc], [0.5, 0.9, len], 'stud', t.grassDark, { collide: false })
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
  const zc = (ZF + ZB) / 2

  // Ground: split into strips so the mini-park quarter pipe has no floor under it.
  const pipeX = 34
  b.box([(-X + pipeX) / 2, -0.5, zc], [X + pipeX, 1, depth], 'stud', t.floor)
  b.box([(pipeX + X) / 2, -0.5, ZF - 4], [X - pipeX, 1, 8], 'stud', t.floor)
  b.box([(pipeX + X) / 2, -0.5, (ZB + ZF - 26) / 2], [X - pipeX, 1, ZF - 26 - ZB], 'stud', t.floor)

  // Earth cliffs all around with a gap at the back for the stage-1 gate.
  b.cliff(-1, X, ZF + 6, ZB - 6, -2)
  b.cliff(1, X, ZF + 6, ZB - 6, -2)
  b.box([0, (WALL_H - 2) / 2 - 1, ZF + 3], [2 * X, WALL_H + 2, 6], 'dirt', t.wall)
  b.box([0, WALL_H + 0.35, ZF + 4.7], [2 * X - 0.4, 0.7, 9.4], 'stud', t.wallTop, { collide: false })
  b.box([0, WALL_H + 0.1, ZF - 0.15], [2 * X - 1, 0.9, 0.5], 'stud', t.grassDark, { collide: false })
  // Back wall either side of the stage-1 gate. The first stage's cliffs cover
  // x in [H, H+6] there, so the lobby walls start beyond them (no overlap).
  for (const s of [-1, 1]) {
    const x0 = H + 6
    const x1 = X - 0.2
    b.box([s * ((x0 + x1) / 2), (WALL_H - 2) / 2 - 1, ZB - 3], [x1 - x0, WALL_H + 2, 6], 'dirt', t.wall)
    b.box([s * ((H + 9.5 + x1) / 2), WALL_H + 0.35, ZB - 4.7], [x1 - H - 9.5, 0.7, 9.4], 'stud', t.wallTop, { collide: false })
    b.box([s * ((H + 0.3 + x1) / 2), WALL_H + 0.1, ZB + 0.15], [x1 - H - 0.3, 0.9, 0.5], 'stud', t.grassDark, { collide: false })
  }
  // Trees along the cliff tops.
  for (let z = ZB; z <= ZF; z += 13) {
    for (const s of [-1, 1]) b.tree([s * (X + 5 + ((z * 7) % 4)), WALL_H + 0.7, z], 1 + (((z * 13) % 5) / 10), false)
  }
  for (let x = -X + 6; x <= X - 6; x += 14) b.tree([x, WALL_H + 0.7, ZF + 6], 1.1, false)

  // Spawn plate + planters.
  b.box([0, 0.12, 22], [8, 0.24, 8], 'plain', w === 0 ? '#a7a1c2' : '#2af5c8')
  b.out.spawn = [b.ox, 0.4, 22]
  b.out.spawnRy = Math.PI
  for (const sx of [-1, 1]) {
    b.prop('planter', [sx * 6.5, 0, 27])
    b.prop('lamp', [sx * 5.5, 0, 14])
  }

  // Path from the spawn to the stage-1 gate.
  b.decal(0, -9, 8, 40, t.floorAlt)
  for (const sx of [-1, 1]) b.decal(sx * 4.15, -9, 0.3, 40, '#ffd21f')
  for (let k = 0; k < 5; k += 1) b.chevron(0, 8 - k * 9, 0, '#ffffff')

  /* ---- Shop: right beside the spawn, facing it. Walk in to open. ---- */
  const sx0 = -14
  const sz0 = 22
  b.box([sx0, 0.06, sz0], [11, 0.12, 10], 'wood', t.wood)
  b.box([sx0 - 2.6, 0.8, sz0], [1.4, 1.6, 8.4], 'wood', t.wood)
  b.box([sx0 - 2.6, 1.7, sz0], [1.8, 0.2, 8.8], 'plain', '#ffffff')
  for (const [x, z] of [[-5, 4.4], [4.6, 4.4], [-5, -4.4], [4.6, -4.4]]) b.box([sx0 + x, 3.6, sz0 + z], [0.6, 7.2, 0.6], 'wood', t.wood)
  b.decor({ kind: 'awning', p: [sx0 - 0.2, 7.4, sz0], w: 10.6, d: 9.6 })
  b.decor({ kind: 'shopkeeper', p: [sx0 - 4, 0, sz0], ry: 0 })
  b.sign('SHOP', [sx0 - 0.2, 10.6, sz0 + 4.9], { sub: 'Charms · Glows · Boosts', size: 3, ry: 0, color: '#ffe14d', subColor: '#ffffff' })
  b.out.shopRect = b.rect(sx0 - 1.8, sx0 + 4.4, sz0 - 4.4, sz0 + 4.4)
  b.out.shop = { p: [b.ox + sx0, 0, sz0] }

  /* ---- World portal (right of the spawn) ---- */
  b.out.portal = { p: [b.ox + 15, 0, 24], r: 3.8, to: w === 0 ? 1 : 0 }

  /* ---- Upgrades: skateboard pads (back-left), two rows of five ---- */
  b.sign('UPGRADES', [-27, 11.5, ZB + 0.8], { sub: 'Better boards, more speed!', size: 3.2 })
  b.decal(-26.4, -29, 28, 18, w === 0 ? '#cdbdff' : '#4a3a8a')
  const boards = BOARDS.filter((bd) => bd.world === w)
  boards.forEach((bd, i) => {
    const row = Math.floor(i / 5)
    b.out.boardPads.push({ board: bd.id, p: [b.ox - 36.8 + (i % 5) * 5.2, 0, row === 0 ? -22.5 : -34.5] })
  })

  /* ---- Treadmills (back-right): two rows of four in wooden stalls ---- */
  b.sign('TREADMILLS', [27, 11.5, ZB + 0.8], { sub: 'Stand on one to train speed!', size: 3.2, subColor: '#ffe14d' })
  b.decal(27, -27.5, 26, 23, w === 0 ? '#c4e8ff' : '#2a4a7a')
  LOBBY_TREADMILLS[w].forEach((tm, i) => {
    b.out.treadmills.push({
      id: lobbyTreadmillId(w, i),
      p: [b.ox + 18.6 + (i % 4) * 5.8, 0, i < 4 ? -21 : -33.5],
      mult: tm.mult,
      cost: tm.cost,
      color: tm.color,
      lobby: true,
      world: w,
    })
  })

  /* ---- Trick park (middle band): funbox + rails on the left, quarter pipe,
     kicker and ledge on the right. ---- */
  const fz = -2
  b.wedge([-24, 0, fz + 5.25], [9, 1.2, 3.5], 0, 'stud', t.accent[2])
  b.box([-24, 0.6, fz], [9, 1.2, 7], 'stud', t.accent[2])
  b.wedge([-24, 0, fz - 5.25], [9, 1.2, 3.5], Math.PI, 'stud', t.accent[2])
  b.rail([-30.5, 0.85, fz + 6], [-30.5, 0.85, fz - 6])
  b.rail([-17.5, 0.85, fz + 6], [-17.5, 0.85, fz - 6])
  b.ledge(-11, fz + 7, fz - 7, 0.55, t.accent[4])

  b.pipe([pipeX, 0, ZF - 8 - 9], 0, 18, 4.5, t.floorAlt, 72)
  const qpRun = 4.5 * Math.sin((72 * Math.PI) / 180)
  const qpTop = 4.5 * (1 - Math.cos((72 * Math.PI) / 180))
  b.box([(pipeX + qpRun + X) / 2, qpTop / 2, ZF - 17], [X - pipeX - qpRun, qpTop, 18], 'stud', t.floorAlt)
  b.rail([pipeX + qpRun, qpTop + 0.12, ZF - 25.6], [pipeX + qpRun, qpTop + 0.12, ZF - 8.4], '#f0f2f8', { posts: false, collider: false })
  b.wedge([24, 0, 0], [5, 1.0, 3.5], -Math.PI / 2, 'stud', t.accent[0])
  b.rail([16, 0.9, 6], [16, 0.9, -8])
  b.sign('TRICK PARK', [24, 7, -9], { size: 1.8, color: '#ffffff', sub: 'Jump · Grind · Flip!', subColor: '#ffe14d' })

  // A few cones and benches.
  b.prop('bench', [-24, 0, 12], { ry: 0 })
  b.prop('bench', [24, 0, 14], { ry: 0 })
  b.prop('cone', [9, 0, 8])
  b.prop('cone', [11, 0, 6])

  // Bunting high above the lobby.
  for (const zz of [-8, 12]) b.decor({ kind: 'bunting', p: [0, 15, zz], w: 2 * X, colors: t.accent })
  for (const fx of [-38, -16, 16, 38]) b.decor({ kind: 'flagpole', p: [fx, 0, ZB + 2], color: t.accent[Math.abs(fx) % t.accent.length] })

  // Title over the front cliff, facing into the lobby.
  b.sign('+1 SPEED SKATEBOARD ESCAPE', [0, 19.8, ZF - 0.5], { size: 3, ry: Math.PI, color: '#ffffff', sub: 'Become the FASTEST on the server!', subColor: '#ffe14d' })

  /* ---- Leaderboards on the front cliff ---- */
  b.out.leaderboards.push({ kind: 'speed', p: [b.ox - 21, 8.6, ZF - 0.2], ry: Math.PI })
  b.out.leaderboards.push({ kind: 'wins', p: [b.ox, 8.6, ZF - 0.2], ry: Math.PI })
  b.out.leaderboards.push({ kind: 'rebirths', p: [b.ox + 21, 8.6, ZF - 0.2], ry: Math.PI })

  b.out.lobby = {
    spawn: b.out.spawn,
    treadmills: [b.ox + 27, 0.4, -12],
    boards: [b.ox - 26, 0.4, -14],
    shop: [b.ox - 7, 0.4, 22],
  }
}

/* ------------------------------------------------------------------- stages */

function stageContext(w, s) {
  const rec = RECOMMENDED_LEVEL[w][s - 1]
  const vReq = moveSpeedFor(rec, 1)
  const jumpMax = vReq * AIR_TIME
  const d = clamp((s - 1) / Math.max(1, stageCount(w) - 1) + (w === 1 ? 0.1 : 0), 0, 1)
  return { rec, vReq, jumpMax, safe: jumpMax * 0.6, d, rng: mulberry32(9973 * (w + 1) + s * 131), stage: s }
}

const pick = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length]

/**
 * Visual steps over an invisible smooth ramp (so riding down is smooth). The
 * steps never share a top height with anything else.
 */
function stairSet(b, zTop, hTop, hBottom, run, color) {
  const steps = Math.max(2, Math.round((hTop - hBottom) / 0.42))
  for (let i = 0; i < steps; i += 1) {
    const top = hTop - ((i + 1) * (hTop - hBottom)) / steps
    if (top - hBottom <= 0.001) continue
    b.box([0, (top + hBottom) / 2, zTop - (i + 0.5) * (run / steps)], [2 * H, top - hBottom, run / steps], 'stud', color, { collide: false })
  }
  b.wedge([0, hBottom, zTop - run / 2], [2 * H, hTop - hBottom, run], Math.PI, 'stud', color, { visible: false })
}

/**
 * Segments. Each starts at z with the full-width floor ending there (top y=0)
 * and returns the z where it ends, again at y=0 full width (or the next
 * segment's floor). Pieces inside a segment abut, they never overlap.
 */
const SEG = {
  /** Plaza: manual pads, ledges, banks, benches and a planter. */
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
    b.stripe(z - 15 + 0.6)
    b.floor(z - 15 - gap, z - 32 - gap)
    b.stripe(z - 15 - gap - 0.6)
    b.prop('rock', [-H + 3, WATER_Y + 0.4, z - 15 - gap / 2], { k: 1.3 })
    b.prop('rock', [H - 4, WATER_Y + 0.4, z - 15 - gap / 2], { k: 1 })
    return z - 32 - gap
  },

  /**
   * City street with live traffic: four lanes of cars driving up and down the
   * road. Getting hit sends you back, so time your crossing between them.
   */
  street(b, z, c) {
    const t = b.theme
    const len = 64
    b.floor(z, z - len, -H + 4, H - 4, t.road)
    b.floor(z, z - len, -H, -H + 4, t.sidewalk, 'stud', 0.25)
    b.floor(z, z - len, H - 4, H, t.sidewalk, 'stud', 0.25)
    b.laneLine(0, z - 1, 0, z - len + 1)
    for (const sx of [-1, 1]) b.decal(sx * (H - 4.6), z - len / 2, 0.3, len - 2, '#ffffff')
    for (let zz = z - 8; zz > z - len; zz -= 16) {
      b.prop('lamp', [-H + 1.2, 0.25, zz])
      b.prop('lamp', [H - 1.2, 0.25, zz - 8])
    }
    // Two lanes each way: left lanes drive toward you, right lanes away.
    const lanes = [
      { x: -10.5, dir: 1 },
      { x: -3.6, dir: 1 },
      { x: 3.6, dir: -1 },
      { x: 10.5, dir: -1 },
    ]
    const perLane = c.d > 0.4 ? 3 : 2
    const speed = r2(7 + 6 * c.d)
    lanes.forEach((lane, li) => {
      const laneSpeed = r2(speed * (0.85 + 0.12 * li))
      for (let k = 0; k < perLane; k += 1) {
        b.out.obstacles.push({
          id: `car${b.w}_${Math.round(-z)}_${li}_${k}`,
          kind: 'car',
          x: b.ox + lane.x,
          z0: z - 1,
          z1: z - len + 1,
          dir: lane.dir,
          speed: laneSpeed,
          phase: r2(k / perLane + li * 0.13 + c.rng() * 0.08),
          color: pick(t.cars, c.rng),
        })
      }
    })
    b.sign('WATCH FOR TRAFFIC!', [0, 9, z - 2], { size: 1.6, color: '#ff6b4d' })
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
    b.floor(z, z - 4)
    b.wedge([0, 0, z - 8.5], [2 * H, h, 9], 0, 'stud', t.floorAlt)
    b.box([0, h / 2, z - 16], [2 * H, h, 6], 'stud', t.floorAlt)
    stairSet(b, z - 19, h, 0, 7, t.floorAlt)
    b.floor(z - 26, z - 40)
    for (const x of c.d > 0.5 ? [-4, 4] : [-5, 5]) b.rail([x, h + 0.85, z - 18.6], [x, 0.85, z - 26.4])
    b.ledge(-13, z - 13.5, z - 18.5, h + 0.55, t.accent[2])
    b.prop('planter', [12, h, z - 16])
    return z - 40
  },

  /** Two stair sets with a landing in between, rails on both. */
  bigStairs(b, z) {
    const t = b.theme
    const h = 4.4
    const mid = 2.2
    b.floor(z, z - 2)
    b.wedge([0, 0, z - 10], [2 * H, h, 16], 0, 'stud', t.floorAlt)
    b.box([0, h / 2, z - 21], [2 * H, h, 6], 'stud', t.floorAlt)
    // Solid block under the upper flight, then the landing.
    b.box([0, mid / 2, z - 27], [2 * H, mid, 6], 'stud', t.floorAlt)
    stairSet(b, z - 24, h, mid, 6, t.floorAlt)
    b.box([0, mid / 2, z - 33], [2 * H, mid, 6], 'stud', t.floorAlt)
    stairSet(b, z - 36, mid, 0, 6, t.floorAlt)
    b.floor(z - 42, z - 54)
    for (const x of [-6, 6]) {
      b.rail([x, h + 0.85, z - 23.6], [x, mid + 0.85, z - 30.4])
      b.rail([x, mid + 0.85, z - 35.6], [x, 0.85, z - 42.4])
    }
    b.rail([0, h + 0.9, z - 23.6], [0, 0.9, z - 42.4])
    b.prop('lamp', [-H + 1, h, z - 20])
    b.prop('lamp', [H - 1, mid, z - 32])
    return z - 54
  },

  /** Zig-zag road over the river (narrows with difficulty). No curbs! */
  narrowRoad(b, z, c) {
    const t = b.theme
    const width = r2(Math.max(5, 10 - 5 * c.d))
    const a = r2(Math.min(H - width / 2 - 1, 5 + 5 * c.d))
    b.floor(z, z - 6)
    b.ribbon(
      [[0, 0, z - 6], [0, 0, z - 12], [a, 0, z - 26], [a, 0, z - 36], [-a, 0, z - 52], [-a, 0, z - 60], [0, 0, z - 70], [0, 0, z - 74]],
      { w: width, color: t.road, curb: false, pillars: true },
    )
    b.prop('rock', [-H + 4, WATER_Y + 0.3, z - 30], { k: 1.6 })
    b.prop('rock', [H - 3, WATER_Y + 0.3, z - 58], { k: 1.3 })
    b.floor(z - 74, z - 82)
    return z - 82
  },

  /** Wide S-bend road over the river with curbs, lily pads and rocks below. */
  riverbend(b, z, c) {
    const t = b.theme
    const len = 80
    b.ribbon(
      [[0, 0, z], [0, 0, z - 6], [-8, 0, z - 20], [-8, 0, z - 32], [8, 0, z - 50], [8, 0, z - 60], [0, 0, z - 74], [0, 0, z - len]],
      { w: 12, color: t.road, curb: true, pillars: true },
    )
    for (let i = 0; i < 6; i += 1) {
      b.prop('lily', [(i % 2 ? 1 : -1) * (12 + c.rng() * 4), WATER_Y + 0.02, z - 8 - i * 12])
    }
    b.prop('rock', [-H + 3, WATER_Y + 0.4, z - 22], { k: 1.5 })
    b.prop('rock', [H - 3, WATER_Y + 0.4, z - 58], { k: 1.3 })
    return z - len
  },

  /** Rolling hill road: climb (slows you) and drop (speeds you up) over the river. */
  hillRoad(b, z, c) {
    const t = b.theme
    const len = 72
    const h1 = r2(3 + 1.5 * c.d)
    const h2 = r2(2 + 1.5 * c.d)
    b.ribbon(
      [[0, 0, z], [0, 0, z - 4], [-4, h1 * 0.6, z - 14], [-4, h1, z - 22], [2, h1 * 0.4, z - 32], [4, 0.6, z - 40], [4, h2, z - 50], [0, h2 * 0.5, z - 60], [0, 0, z - 68], [0, 0, z - len]],
      { w: 14, color: t.road, curb: true, pillars: true },
    )
    b.sign('HILL ROAD', [0, h1 + 7, z - 22], { size: 1.6, color: '#ffe14d' })
    return z - len
  },

  /** Wooden bridge whose planks shake and drop once ridden over. Keep moving! */
  crumbleBridge(b, z, c) {
    const t = b.theme
    b.floor(z, z - 6)
    const planks = 12 + Math.round(4 * c.d)
    const pl = 1.6
    const gap = 0.12
    const width = r2(Math.max(5, 8 - 3 * c.d))
    let cz = z - 6
    for (let i = 0; i < planks; i += 1) {
      b.crumble([0, -0.25, cz - pl / 2], [width, 0.5, pl], i % 2 ? t.wood : '#c98a4f')
      cz -= pl + gap
    }
    // Rope posts along the sides (visual).
    for (const sx of [-1, 1]) {
      for (let zz = z - 6; zz >= cz; zz -= 4) b.cylinder([sx * (width / 2 + 0.4), WATER_Y, zz], 0.18, -WATER_Y + 1.6, t.wood, { collide: false })
      b.rail([sx * (width / 2 + 0.4), 1.5, z - 6], [sx * (width / 2 + 0.4), 1.5, cz], '#e8d2a6', { posts: false, collider: false })
    }
    b.sign('CRUMBLING BRIDGE', [0, 7, z - 4], { sub: "Don't stop!", size: 1.6, color: '#ffb31f', subColor: '#ffffff' })
    b.floor(cz, cz - 10)
    return cz - 10
  },

  /** Trick garden: kickers, flat bars, a hubba ledge and an A-frame rail. */
  trickGarden(b, z) {
    const t = b.theme
    const len = 54
    b.floor(z, z - len)
    b.wedge([-10, 0, z - 8], [6, 1.0, 3.5], 0, 'stud', t.accent[0])
    b.box([-10, 0.5, z - 13.25], [6, 1.0, 7], 'stud', t.accent[0])
    b.wedge([-10, 0, z - 18.5], [6, 1.0, 3.5], Math.PI, 'stud', t.accent[0])
    for (const x of [2, 7]) b.rail([x, 0.6, z - 6], [x, 0.6, z - 20])
    // Hubba: a ledge that runs down the side of a stair block.
    b.box([12, 0.9, z - 27], [8, 1.8, 6], 'stud', t.floorAlt)
    b.wedge([12, 0, z - 33], [8, 1.8, 6], Math.PI, 'stud', t.floorAlt)
    b.wedge([12, 0, z - 21], [8, 1.8, 6], 0, 'stud', t.floorAlt)
    b.rail([8.3, 2.0, z - 29.8], [8.3, 0.7, z - 35.6], '#ffe14d')
    // A-frame rail.
    b.rail([-6, 0.6, z - 30], [-6, 1.6, z - 36])
    b.rail([-6, 1.6, z - 36], [-6, 0.6, z - 42])
    b.ledge(-14, z - 32, z - 46, 0.55, t.accent[3])
    b.wedge([0, 0, z - 48], [10, 1.0, 4], 0, 'stud', t.accent[4])
    b.sign('TRICK GARDEN', [0, 7, z - 4], { size: 1.8, color: '#ffffff', sub: 'Grind every rail!', subColor: '#ffe14d' })
    return z - len
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
    for (const zz of [z - 18, z - 33]) {
      for (let i = 0; i < 8; i += 1) b.decal(-H + 2 + i * ((2 * H - 4) / 7), zz, 1.6, 3, '#ffffff')
    }
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
    b.box([-5, -0.5, z - 8 - gap / 2], [bw, 1, gap], 'wood', t.wood)
    b.rail([4, 0.9, z - 5], [4, 0.9, z - 8 - gap - 3])
    if (c.d > 0.45) b.rail([10, 1.6, z - 5], [10, 0.9, z - 8 - gap - 3])
    b.stripe(z - 8 + 0.6)
    b.prop('rock', [-H + 4, WATER_Y + 0.4, z - 16], { k: 1.4 })
    b.floor(z - 8 - gap, z - 22 - gap)
    return z - 22 - gap
  },

  /** Half pipe: two quarter pipes facing each other. Floor only between them. */
  halfPipe(b, z, c) {
    const t = b.theme
    const R = 5.5
    const phi = (70 * Math.PI) / 180
    const run = R * Math.sin(phi)
    const top = R * (1 - Math.cos(phi))
    const L = 36
    b.floor(z, z - 2)
    b.floor(z - 2, z - 2 - L, -6, 6)
    b.floor(z - 2 - L, z - 4 - L)
    for (const s of [-1, 1]) {
      b.pipe([s * 6, 0, z - 2 - L / 2], s > 0 ? 0 : Math.PI, L, R, t.floorAlt)
      const deckW = H - 6 - run
      b.box([s * (6 + run + deckW / 2), top / 2, z - 2 - L / 2], [deckW, top, L], 'stud', t.floorAlt)
      b.rail([s * (6 + run), top + 0.12, z - 3], [s * (6 + run), top + 0.12, z - 1 - L], '#f0f2f8', { posts: false, collider: false })
    }
    if (c.d > 0.6) {
      b.out.obstacles.push({ id: `sw${b.w}_${Math.round(-z)}hp`, kind: 'sweeper', p: [b.ox, 0.55, z - 2 - L / 2], radius: 5.6, spin: 1.4, phase: r2(c.rng() * 6) })
      b.cylinder([0, 0, z - 2 - L / 2], 0.8, 2, '#ffd21f')
    }
    return z - 4 - L
  },

  /** Bowl: pipes on both sides and a pyramid in the middle with a hip rail. */
  bowl(b, z, c) {
    const t = b.theme
    const L = 42
    const R = 5
    const run = R * Math.sin((70 * Math.PI) / 180)
    const top = R * (1 - Math.cos((70 * Math.PI) / 180))
    b.floor(z, z - 2)
    b.floor(z - 2, z - 2 - L, -9, 9)
    b.floor(z - 2 - L, z - 4 - L)
    for (const s of [-1, 1]) {
      b.pipe([s * 9, 0, z - 2 - L / 2], s > 0 ? 0 : Math.PI, L, R, t.accent[3])
      const deckW = H - 9 - run
      b.box([s * (9 + run + deckW / 2), top / 2, z - 2 - L / 2], [deckW, top, L], 'stud', t.floorAlt)
    }
    const pz = z - 2 - L / 2
    b.box([0, 0.75, pz], [5, 1.5, 5], 'stud', t.accent[1])
    b.wedge([0, 0, pz + 4.5], [5, 1.5, 4], 0, 'stud', t.accent[1])
    b.wedge([0, 0, pz - 4.5], [5, 1.5, 4], Math.PI, 'stud', t.accent[1])
    b.wedge([4.5, 0, pz], [5, 1.5, 4], Math.PI / 2, 'stud', t.accent[1])
    b.wedge([-4.5, 0, pz], [5, 1.5, 4], -Math.PI / 2, 'stud', t.accent[1])
    b.rail([0, 1.62, pz + 2], [0, 1.62, pz - 2], '#ffffff', { posts: false, collider: true })
    if (c.d > 0.35) {
      b.out.obstacles.push({ id: `g${b.w}_${Math.round(-z)}bw`, kind: 'granny', x0: b.ox - 6, x1: b.ox + 6, z: z - 8, speed: r2(2.5 + 3 * c.d), phase: r2(c.rng()) })
    }
    return z - 4 - L
  },

  /** Construction site: crate stacks to weave through, ramps onto them, barrels. */
  crates(b, z, c) {
    const t = b.theme
    const len = 52
    b.floor(z, z - len, -H, H, t.sidewalk)
    const rows = [z - 10, z - 24, z - 38]
    rows.forEach((rz, i) => {
      const gapX = (i % 2 === 0 ? 1 : -1) * (6 + c.rng() * 4)
      for (let x = -H + 2; x <= H - 2; x += 4) {
        if (Math.abs(x - gapX) < 4) continue
        b.box([x, 1, rz], [3.6, 2, 3.6], 'wood', t.wood)
        if (c.rng() < 0.35) b.box([x, 3, rz], [3, 2, 3], 'wood', t.wood)
      }
      b.wedge([-gapX * 0.6, 0, rz + 4.3], [4, 2, 5], 0, 'stud', t.accent[0])
      b.prop('barrel', [gapX + 3.5, 0, rz - 4], { color: '#ff7a1f' })
      b.prop('barrel', [gapX - 3.5, 0, rz + 4], { color: '#3b7bff' })
    })
    b.prop('cone', [-2, 0, z - 4])
    b.prop('cone', [2, 0, z - 4])
    b.sign('HARD HAT AREA', [0, 12, z - 2], { size: 1.6, color: '#ffd21f' })
    return z - len
  },

  /** Mega ramp: climb, drop in to build speed, launch over the river. */
  megaRamp(b, z, c) {
    const t = b.theme
    const h = 6
    b.floor(z, z - 6)
    b.wedge([0, 0, z - 17], [2 * H, h, 22], 0, 'stud', t.floorAlt)
    b.box([0, h / 2, z - 32], [2 * H, h, 8], 'stud', t.floorAlt)
    b.wedge([0, 0, z - 43], [2 * H, h, 14], Math.PI, 'stud', t.accent[3])
    b.floor(z - 50, z - 64)
    b.wedge([0, 0, z - 61.5], [14, 1.4, 5], 0, 'stud', t.accent[0])
    const gap = r2(Math.min(c.jumpMax * 0.8, 4 + 6 * c.d))
    b.stripe(z - 64 + 0.6)
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

/** Each stage is a themed adventure. World 2 remixes them under neon lights. */
const PLANS = [
  ['plaza', 'funbox', 'kickerGap'],
  ['street', 'stairs', 'bigStairs'],
  ['street', 'granny', 'cones'],
  ['trickGarden', 'railBridge', 'stones'],
  ['halfPipe', 'bowl', 'kickerGap'],
  ['crates', 'sweepers', 'movers'],
  ['megaRamp', 'bigStairs', 'granny'],
  ['stones', 'movers', 'railBridge', 'narrowRoad'],
  ['halfPipe', 'sweepers', 'bowl', 'movers'],
  ['street', 'granny', 'crates', 'megaRamp', 'stones'],
  ['riverbend', 'stones', 'crumbleBridge'],
  ['crumbleBridge', 'hillRoad', 'crumbleBridge'],
  ['hillRoad', 'bowl', 'narrowRoad'],
  ['trickGarden', 'halfPipe', 'crumbleBridge', 'sweepers'],
  ['megaRamp', 'riverbend', 'crumbleBridge', 'hillRoad'],
]
const PLANS_W2 = [
  ['street', 'cones', 'granny'],
  ['bigStairs', 'stairs', 'kickerGap'],
  ['bowl', 'halfPipe', 'sweepers'],
  ['railBridge', 'narrowRoad', 'crumbleBridge'],
  ['street', 'granny', 'cones', 'hillRoad'],
  ['crates', 'movers', 'sweepers', 'crates'],
  ['megaRamp', 'stones', 'megaRamp'],
  ['riverbend', 'movers', 'stones', 'railBridge'],
  ['halfPipe', 'bowl', 'sweepers', 'movers'],
  ['megaRamp', 'crates', 'granny', 'crumbleBridge', 'hillRoad'],
]

function buildStage(b, s, zStart) {
  const w = b.w
  const t = b.theme
  const c = stageContext(w, s)
  const isLast = s === stageCount(w)
  const name = STAGE_NAMES[w][s - 1]
  let z = zStart

  // Start section + gate.
  b.floor(z, z - 18)
  b.decor({ kind: 'arch', p: [0, 0, z], w: 2 * H, color: t.accent[s % t.accent.length] })
  b.sign(`STAGE ${stageNumber(w, s)}`, [0, 11.2, z - 0.7], { sub: `${name}  ·  Recommended Level: ${c.rec}`, size: 4 })
  const startRect = b.rect(-H, H, z - 18, z)
  const spawn = [b.ox, 0.4, r2(z - 8)]
  for (const sx of [-1, 1]) {
    b.prop('planter', [sx * (H - 2), 0, z - 4])
    b.prop('planter', [sx * (H - 2), 0, z - 14])
    b.prop('cone', [sx * 6, 0, z - 15])
  }
  for (let k = 0; k < 3; k += 1) b.chevron(0, z - 4 - k * 4, 0, '#ffffff')
  z -= 18

  const plan = (w === 0 ? PLANS : PLANS_W2)[s - 1]
  for (const seg of plan) z = SEG[seg](b, z, c)

  // Speed gap: sized so the recommended level clears it with a little room.
  b.floor(z, z - 10)
  for (let k = 0; k < 2; k += 1) b.chevron(0, z - 3 - k * 4, 0, '#ffd21f')
  z -= 10
  const gapStart = z
  const gap = r2(Math.max(3, c.vReq * AIR_TIME * 0.92))
  b.stripe(z + 0.6)
  b.sign('SPEED GAP', [0, 6, z - gap / 2], { sub: `Level ${c.rec}+`, size: 2.4, color: '#ffe14d', subColor: '#ffffff' })
  z -= gap

  // Finish platform: middle lane open to the next gate; FREE side left, VIP right.
  const endStart = z
  const FIN = 36
  b.floor(z, z - FIN, -H, H, t.floor)
  b.stripe(z - 0.6)
  b.decal(0, z - FIN / 2 + 2, 9, FIN - 8, t.floorAlt)
  for (let row = 0; row < 2; row += 1) {
    for (let i = 0; i < 18; i += 1) {
      b.decal(-H + (i + 0.5) * ((2 * H) / 18), z - FIN + 0.6 + row * 1.0, (2 * H) / 18, 1, (i + row) % 2 ? '#ffffff' : '#1b1530')
    }
  }
  const padZ = r2(z - FIN + 6.5)
  const wins = STAGE_WINS[w][s - 1]
  const sides = [
    { sx: -1, kind: 'return', id: `w${w}_${s}_c`, tm: 0, premium: false },
    { sx: 1, kind: 'return', id: `w${w}_${s}_p`, tm: 1, premium: true },
  ]
  for (const side of sides) {
    const padX = side.sx * 9.6
    const tmX = side.sx * 15
    const glow = side.premium ? '#ffc21f' : '#38f05a'
    b.decal(side.sx * 12.1, padZ, 11.2, 8, t.floorAlt)
    b.decal(side.sx * 12.1, padZ + 4.6, 11.2, 0.3, glow)
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
    for (let k = 0; k < 3; k += 1) {
      b.chevron(side.sx * (2.2 + k * 2.2), padZ + 7.5 - k * 0.9, side.sx > 0 ? -Math.PI / 2 + 0.35 : Math.PI / 2 - 0.35, glow)
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
  for (let k = 0; k < 5; k += 1) b.chevron(0, z - 4 - k * 4.5, 0, '#ffffff')
  z -= FIN

  if (isLast) {
    b.box([0, WALL_H / 2 - 1, z - 3], [2 * H + 12, WALL_H + 2, 6], 'dirt', t.wall)
    b.sign('YOU ESCAPED!', [0, 11, z + 0.2], { sub: b.w === 0 ? 'World 2 awaits...' : 'Legend of the park!', size: 4.5, color: '#ffe14d', subColor: '#ffffff' })
  }

  // Earth cliffs, bunting, banners and the river below.
  b.cliff(-1, H, zStart, z)
  b.cliff(1, H, zStart, z)
  b.water(zStart, z)
  for (let zz = zStart - 22; zz > z + 10; zz -= 30) b.decor({ kind: 'bunting', p: [0, WALL_H - 2.5, zz], w: 2 * H, colors: t.accent })
  let bannerI = 0
  for (let zz = zStart - 18; zz > z + 6; zz -= 40) {
    for (const side of [-1, 1]) {
      b.decor({ kind: 'banner', p: [side * (H - 0.05), WALL_H - 4, zz], side: -side, color: t.accent[(s + bannerI) % t.accent.length] })
      bannerI += 1
    }
  }
  // Riverbank rocks along the cliff base.
  for (let zz = zStart - 10; zz > z + 10; zz -= 17 + c.rng() * 8) {
    for (const side of [-1, 1]) if (c.rng() < 0.6) b.prop('rock', [side * (H - 0.6 - c.rng() * 1.2), WATER_Y - 0.4, r2(zz)], { k: 0.8 + c.rng() * 0.8 })
  }

  // Houses, trees, bushes and rocks on the cliff tops (decorative).
  for (let zz = zStart - 6; zz > z + 6; zz -= 12 + c.rng() * 8) {
    for (const side of [-1, 1]) {
      const r = c.rng()
      if (r < 0.35) {
        const hw = 6 + c.rng() * 6
        const hh = 5 + c.rng() * 9
        b.decor({
          kind: 'house',
          p: [side * (H + 7 + hw / 2 + c.rng() * 4), WALL_H + 0.7, r2(zz)],
          s: [r2(hw), r2(hh), r2(6 + c.rng() * 6)],
          color: t.houses[Math.floor(c.rng() * t.houses.length)],
        })
      } else if (r < 0.85) {
        b.tree([side * (H + 5 + c.rng() * 7), WALL_H + 0.7, r2(zz)], 0.8 + c.rng() * 0.5, false)
        b.prop('bush', [side * (H + 2.5 + c.rng() * 2), WALL_H + 0.7, r2(zz + 3)], { k: 0.9 })
      } else {
        b.prop('rock', [side * (H + 4 + c.rng() * 6), WALL_H + 0.7, r2(zz)], { k: 1 + c.rng() })
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
    endRect: b.rect(-H, H, endStart - FIN, endStart),
    wins,
  })
  return z
}

/** Builds one world. Pure function of `w`. */
export function buildWorld(w) {
  const b = new Builder(w)
  buildLobby(b)
  let z = LOBBY_BACK_Z
  for (let s = 1; s <= stageCount(w); s += 1) z = buildStage(b, s, z)
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
  return layout.stages.length
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

/**
 * Traffic car position at time t: drives the length of its street, then loops.
 * `grow` (0..1) shrinks the car at the ends so it doesn't pop in and out.
 */
export function carPos(o, t) {
  const span = o.z0 - o.z1
  const u = (((t * o.speed) / span + o.phase) % 1 + 1) % 1
  const z = o.dir > 0 ? o.z1 + u * span : o.z0 - u * span
  const grow = Math.min(1, u / 0.05, (1 - u) / 0.05)
  return { x: o.x, z, grow }
}

export function sweeperAngle(o, t) {
  return o.phase + o.spin * t
}

export function moverPos(m, t) {
  const x = m.p[0] + Math.sin(((t / m.period + m.phase) % 1) * Math.PI * 2) * m.amp
  return [x, m.p[1], m.p[2]]
}
