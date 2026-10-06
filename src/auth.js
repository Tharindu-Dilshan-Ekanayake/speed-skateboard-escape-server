import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'

import { GAME_ID } from './shared/config.js'

/**
 * Session tokens. Every pod signs/verifies with the same JWT_SECRET, so a token
 * issued by the HTTP endpoint on one pod is accepted by a room on any other pod.
 */

const DEV_SECRET = 'dev-only-secret-change-me'
const SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === 'production' ? crypto.randomBytes(32).toString('hex') : DEV_SECRET)

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[auth] JWT_SECRET missing in production - tokens only valid on this pod')
}

const BLOXITY_API = process.env.BLOXITY_API_URL || 'https://api.bloxity.io'
const GAME_SLUG = process.env.BLOXITY_GAME_ID || GAME_ID

export function signSession(payload, expiresIn = '30d') {
  return jwt.sign(payload, SECRET, { expiresIn })
}

export function verifySession(token) {
  if (typeof token !== 'string' || token.length > 2048) return null
  try {
    const data = jwt.verify(token, SECRET)
    if (!data || typeof data.pid !== 'string') return null
    return data
  } catch {
    return null
  }
}

/** Display names: letters, digits, underscores and spaces only. */
export function cleanName(name, fallback = 'Player') {
  const cleaned = String(name || '')
    .replace(/[^\p{L}\p{N}_ .-]/gu, '')
    .trim()
    .slice(0, 20)
  return cleaned || fallback
}

export function newGuestId() {
  return `g:${crypto.randomBytes(9).toString('base64url')}`
}

/**
 * Verifies a Bloxity game token with the platform and returns the user, or null.
 * Throws only on network errors, so callers can tell "rejected" from "unreachable".
 */
export async function verifyBloxityToken(token) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`${BLOXITY_API}/v1/auth/game-token/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameSlug: GAME_SLUG }),
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) return null
    if (!res.ok) throw new Error(`verify HTTP ${res.status}`)
    const body = await res.json()
    const user = body && body.user ? body.user : body
    if (!user || !user._id) return null
    return user
  } finally {
    clearTimeout(timer)
  }
}
