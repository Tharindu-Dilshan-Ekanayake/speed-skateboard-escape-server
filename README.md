# +1 Speed Skateboard Escape — server

Colyseus 0.18 game server. It is authoritative for the economy (speed, wins,
levels, rebirths, purchases, unlocks), validates rider movement, and saves
progress to MongoDB.

## Run locally

```bash
npm install
npm run dev        # http://localhost:2567, restarts on file changes
npm run check      # sanity-checks the generated maps and level curve
```

Without `MONGODB_URI` progress is kept in memory.

## What's inside

```
src/
  index.js          HTTP routes (/health, /api/guest, /api/legion-auth, /api/leaderboard) + Colyseus
  rooms/SkateRoom.js the lobby: 8 riders max; the 9th player gets a new lobby
  profile.js        player profile + every economy action
  schema.js         public per-player state, synced 20x/second
  auth.js           session JWTs, Bloxity token verification
  db.js             MongoDB persistence (memory fallback) + leaderboards
  shared/           game data + map generator, also copied into the client
```

- **Lobbies**: `maxClients = 8`. Colyseus `joinOrCreate` fills a room to 8, then
  opens a new one. Legion's `seatCap` is also 8, so a full pod spawns another.
- **Auth**: guests get a signed token kept in their browser; logged-in Bloxity
  players are verified with `POST api.bloxity.io/v1/auth/game-token/verify`.
  Guest progress moves to the account the first time that account plays.
- **Anti-cheat**: movement packets spend a distance budget based on the rider's
  legal top speed, so teleport and speed hacks get snapped back. Win pads,
  treadmills and stage unlocks are checked against the server-side position.
- **Messages to clients are data only** (result codes, numbers); the client writes
  all player-facing text.
- **Deploys drain**: on SIGTERM every profile is saved, clients are told to hop to
  a fresh pod, and the room closes.

## Environment (injected by Legion)

| Var | Use |
| --- | --- |
| `PORT` | listen port (HTTP + WebSocket) |
| `MONGODB_URI` | managed Mongo for this game + channel |
| `JWT_SECRET` | signs session tokens (shared across pods) |
| `CLIENT_ORIGIN` | allowed CORS origin(s), comma-separated |
| `BLOXITY_GAME_ID`, `BLOXITY_CHANNEL`, `POD_NAME` | logging / token verification |

## Deploy (Bloxity Legion)

`.github/workflows/deploy.yml` builds the Docker image, pushes it to GHCR and calls
the Legion deploy API (`main` → prod, `dev` → dev, `seatCap: 8`, `maxReplicas: 10`).

1. Add the `LEGION_DEPLOY_TOKEN` repository secret.
2. Push to `dev` or `main`.
3. After the first push, make the GHCR package public (repo → Packages → Package
   settings → Change visibility).

Backends: prod `https://speed-skateboard-escape.host.bloxity.io`,
dev `https://speed-skateboard-escape.dev.host.bloxity.io`.
