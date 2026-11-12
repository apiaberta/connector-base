import { Contract } from './models/contract.js'
import { SyncState } from './models/syncState.js'

export const STALE_AFTER_MS = 48 * 60 * 60 * 1000
const STATE_ID = 'base'

export function isStale(lastSuccess, now = Date.now()) {
    if (!lastSuccess) return true
    const ts = new Date(lastSuccess).getTime()
    if (Number.isNaN(ts)) return true
    return (now - ts) > STALE_AFTER_MS
}

export function daysSince(date, now = Date.now()) {
    if (!date) return Infinity
    const ts = new Date(date).getTime()
    if (Number.isNaN(ts)) return Infinity
    return Math.max(0, Math.ceil((now - ts) / 86_400_000))
}

export async function getSyncState() {
    return SyncState.findById(STATE_ID).lean()
}

/**
 * last_success comes from the dedicated sync_state doc so live cache
 * upserts (which bump contract.synced_at) cannot fake a fresh bulk sync.
 * Before the first recorded run, fall back to max(synced_at).
 */
export async function getSyncFreshness() {
    const state = await getSyncState()
    let lastSuccess = state?.last_success ?? null
    if (!lastSuccess) {
        const last = await Contract.findOne().sort({ synced_at: -1 }).select('synced_at').lean()
        lastSuccess = last?.synced_at ?? null
    }
    return {
        last_attempt: state?.last_attempt ?? null,
        last_success: lastSuccess,
        last_error: state?.last_error ?? null,
        last_xlsx_success: state?.last_xlsx_success ?? null,
        last_v2_success: state?.last_v2_success ?? null,
        nif_backfill_at: state?.nif_backfill_at ?? null,
    }
}

export async function markSyncAttempt() {
    await SyncState.updateOne(
        { _id: STATE_ID },
        { $set: { last_attempt: new Date() } },
        { upsert: true }
    )
}

export async function markSyncSuccess(extra = {}) {
    await SyncState.updateOne(
        { _id: STATE_ID },
        {
            $set: {
                last_success: extra.last_success ?? new Date(),
                last_error: null,
                ...extra,
            },
        },
        { upsert: true }
    )
}

export async function markSyncError(message, extra = {}) {
    await SyncState.updateOne(
        { _id: STATE_ID },
        {
            $set: {
                last_error: String(message || 'unknown sync error').slice(0, 2000),
                ...extra,
            },
        },
        { upsert: true }
    )
}

export async function markNifBackfillDone() {
    await SyncState.updateOne(
        { _id: STATE_ID },
        { $set: { nif_backfill_at: new Date() } },
        { upsert: true }
    )
}
