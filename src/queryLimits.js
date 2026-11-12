/**
 * Bounds for list/search and sync so MongoDB and Node stay light on a
 * small VPS (2.2 M contracts). Override via env; defaults are conservative.
 */

function envInt(name, fallback) {
    const n = Number.parseInt(process.env[name] || '', 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
}

export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 100
export const DEFAULT_SEARCH_WINDOW_DAYS = envInt('SEARCH_WINDOW_DAYS', 365)
export const QUERY_MAX_TIME_MS = envInt('QUERY_MAX_TIME_MS', 5_000)
export const SEARCH_MAX_TIME_MS = envInt('SEARCH_MAX_TIME_MS', 5_000)
export const UPSERT_BATCH_SIZE = envInt('UPSERT_BATCH_SIZE', 200)
export const V2_MAX_DAYS = 90
export const V2_FETCH_MAX_DAYS = Math.min(V2_MAX_DAYS, envInt('V2_FETCH_MAX_DAYS', 7))

export const LIST_PROJECTION = {
    _id: 0,
    id: 1,
    description: 1,
    contractingEntity: 1,
    awarded: 1,
    value: 1,
    date: 1,
    type: 1,
    synced_at: 1,
}

export const LOOKUP_PROJECTION = {
    _id: 0,
    id: 1,
    description: 1,
    contractingEntity: 1,
    awarded: 1,
    value: 1,
    date: 1,
    type: 1,
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export function clampPageLimit(page, limit) {
    const parsedPage = Number.parseInt(page, 10)
    const parsedLimit = Number.parseInt(limit, 10)
    const p = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1
    let l = Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIMIT
    if (l < 1) l = 1
    if (l > MAX_LIMIT) l = MAX_LIMIT
    return { page: p, limit: l }
}

export function formatIsoDate(value) {
    const d = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(d.getTime())) return null
    return d.toISOString().slice(0, 10)
}

export function parseIsoDate(value) {
    if (value == null || value === '') return null
    const text = String(value).trim().slice(0, 10)
    return ISO_DAY.test(text) ? text : null
}

export function yearDateRange(year) {
    const y = Number.parseInt(year, 10)
    if (!Number.isFinite(y) || y < 1000 || y > 9999) return null
    return { $gte: `${y}-01-01`, $lte: `${y}-12-31` }
}

/**
 * Date window for text search. NIF-only queries do not use this (they hit
 * the NIF indexes). Callers can pass from/to/year; otherwise last N days.
 */
export function searchDateRange({ from, to, year, now = new Date() } = {}) {
    const yearRange = yearDateRange(year)
    if (yearRange) return yearRange

    const toDate = parseIsoDate(to) || formatIsoDate(now)
    let fromDate = parseIsoDate(from)
    if (!fromDate) {
        const start = new Date(`${toDate}T00:00:00.000Z`)
        start.setUTCDate(start.getUTCDate() - DEFAULT_SEARCH_WINDOW_DAYS)
        fromDate = formatIsoDate(start)
    }
    if (fromDate > toDate) return { $gte: toDate, $lte: fromDate }
    return { $gte: fromDate, $lte: toDate }
}

export function isUnfilteredQuery(query) {
    return query == null || (typeof query === 'object' && !Array.isArray(query) && Object.keys(query).length === 0)
}

export function isMaxTimeError(err) {
    if (!err) return false
    return err.code === 50
        || err.codeName === 'MaxTimeMSExpired'
        || /max.?time/i.test(err.message || '')
}

export function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve))
}
