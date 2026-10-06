import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { MongoClient } from 'mongodb'

/**
 * Player persistence. Uses the managed Mongo database from MONGODB_URI when it is
 * set (Legion injects it), otherwise an in-memory store for local development.
 */

let collection = null
const memory = new Map()

/**
 * Local development only: without Mongo, the memory store is mirrored to a JSON
 * file so restarting the dev server keeps everyone's progress.
 */
const DEV_FILE = process.env.DEV_DB_FILE || '.data/dev-db.json'
const useDevFile = () => !collection && process.env.NODE_ENV !== 'production'
let devWriteTimer = null

function loadDevFile() {
  try {
    const rows = JSON.parse(readFileSync(DEV_FILE, 'utf8'))
    for (const row of rows) memory.set(row._id, row)
    console.log(`[db] loaded ${rows.length} dev profiles from ${DEV_FILE}`)
  } catch {
    /* first run */
  }
}

function scheduleDevWrite() {
  if (!useDevFile() || devWriteTimer) return
  devWriteTimer = setTimeout(() => {
    devWriteTimer = null
    try {
      mkdirSync(dirname(DEV_FILE), { recursive: true })
      writeFileSync(DEV_FILE, JSON.stringify([...memory.values()]))
    } catch (err) {
      console.error('[db] dev file write failed:', err.message)
    }
  }, 1000)
}

export async function connectDb() {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    if (process.env.NODE_ENV === 'production') {
      console.log('[db] MONGODB_URI not set - using in-memory store')
    } else {
      console.log(`[db] MONGODB_URI not set - using dev store ${DEV_FILE}`)
      loadDevFile()
    }
    return
  }
  try {
    const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 })
    await client.connect()
    collection = client.db().collection('players')
    await Promise.all([
      collection.createIndex({ 'stats.totalSpeed': -1 }),
      collection.createIndex({ 'stats.totalWins': -1 }),
      collection.createIndex({ rebirths: -1 }),
    ])
    console.log('[db] connected to MongoDB')
  } catch (err) {
    // Keep the server up; progress is held in memory until Mongo is reachable.
    console.error('[db] MongoDB unavailable, falling back to memory:', err.message)
    collection = null
  }
}

export async function loadProfile(id) {
  if (!collection) return memory.get(id) ? structuredClone(memory.get(id)) : null
  try {
    return await collection.findOne({ _id: id })
  } catch (err) {
    console.error('[db] load failed', id, err.message)
    return memory.get(id) ? structuredClone(memory.get(id)) : null
  }
}

export async function saveProfile(profile) {
  const doc = { ...profile, updatedAt: Date.now() }
  memory.set(doc._id, structuredClone(doc))
  if (!collection) return scheduleDevWrite()
  try {
    const { _id, ...rest } = doc
    await collection.updateOne({ _id }, { $set: rest }, { upsert: true })
  } catch (err) {
    console.error('[db] save failed', profile._id, err.message)
  }
}

export async function deleteProfile(id) {
  memory.delete(id)
  if (!collection) return scheduleDevWrite()
  try {
    await collection.deleteOne({ _id: id })
  } catch (err) {
    console.error('[db] delete failed', id, err.message)
  }
}

/* ------------------------------------------------------------ leaderboards */

const LB_FIELDS = {
  speed: 'stats.totalSpeed',
  wins: 'stats.totalWins',
  rebirths: 'rebirths',
}

let lbCache = { at: 0, data: { speed: [], wins: [], rebirths: [] } }

const pick = (doc, path) => path.split('.').reduce((o, k) => (o ? o[k] : 0), doc) || 0

export async function getLeaderboards() {
  if (Date.now() - lbCache.at < 45_000) return lbCache.data
  const data = {}
  for (const [kind, field] of Object.entries(LB_FIELDS)) {
    let rows = []
    try {
      if (collection) {
        rows = await collection
          .find({ [field]: { $gt: 0 } }, { projection: { name: 1, [field]: 1 } })
          .sort({ [field]: -1 })
          .limit(10)
          .toArray()
      } else {
        rows = [...memory.values()].filter((d) => pick(d, field) > 0).sort((a, b) => pick(b, field) - pick(a, field)).slice(0, 10)
      }
    } catch (err) {
      console.error('[db] leaderboard failed', err.message)
      rows = lbCache.data[kind] ? [] : []
    }
    data[kind] = rows.map((d) => ({ name: d.name || 'Player', value: pick(d, field) }))
  }
  lbCache = { at: Date.now(), data }
  return data
}

export function invalidateLeaderboards() {
  lbCache.at = 0
}
