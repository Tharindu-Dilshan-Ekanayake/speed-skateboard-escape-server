import { schema, t } from '@colyseus/schema'

/**
 * Public, per-player state every client in the room can see. Kept small: it is
 * patched 20 times a second. Private data (inventory, quests…) goes to the owner
 * only, via the "me" message.
 */
export const PlayerState = schema(
  {
    name: t.string(),
    /** JSON avatar payload ({ equipped, proportions }) for remote rendering. */
    look: t.string(),
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    ry: t.float32(),
    /** Animation flags: 1 grounded, 2 grinding, 4 treadmill, 8 pushing, 16 braking. */
    a: t.uint8(),
    /** Trick counter; changes trigger a kickflip/shuvit on other screens. */
    f: t.uint8(),
    /** Horizontal speed in m/s * 10, for animation. */
    v: t.uint16(),
    board: t.uint8(),
    /** Riding style: 0 surfer, 1 classic, 2 chill. */
    st: t.uint8(),
    trail: t.uint8(),
    /** Equipped underglow id (0 = the board's own colour). */
    gl: t.uint8(),
    level: t.uint8(),
    rebirths: t.uint16(),
    world: t.uint8(),
    speed: t.float64(),
    wins: t.float64(),
  },
  'PlayerState',
)

export const SkateState = schema(
  {
    players: t.map(PlayerState),
  },
  'SkateState',
)
