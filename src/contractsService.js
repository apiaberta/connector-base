import { Contract as ContractModel } from './models/contract.js'
import { fetchOfficialContracts, hasOfficialApiKey } from './official.js'
import { toCacheDocument } from './baseApi.js'
import { invalidNifError, normalizeNif } from './nifs.js'
import { getSyncFreshness, isStale } from './syncState.js'

export const LIVE_TIMEOUT_MS = 20_000
const LIVE_WARNING = 'Official BASE API unavailable; returning local cache'

export function toListItem(contract) {
    return {
        id: contract.id,
        description: contract.description,
        contractingEntity: contract.contractingEntity,
        awarded: contract.awarded,
        value: contract.value,
        date: contract.date,
        type: contract.type,
        synced_at: contract.synced_at,
    }
}

export function nifClause(nif) {
    return { $or: [{ contractingNifs: nif }, { awardedNifs: nif }] }
}

export function buildListQuery({ type, year, nif } = {}) {
    const parts = []
    if (type) parts.push({ type })
    if (year) parts.push({ date: { $regex: `^${year}-` } })
    if (nif) parts.push(nifClause(nif))
    if (parts.length === 0) return {}
    if (parts.length === 1) return parts[0]
    return { $and: parts }
}

export function shouldFetchLive({ nif, localCount, lastSuccess, hasKey }) {
    if (!hasKey || !nif) return false
    if (!localCount) return true
    return isStale(lastSuccess)
}

export async function upsertOfficial(records, Contract = ContractModel) {
    const docs = records.map(mapped => toCacheDocument(mapped)).filter(Boolean)
    if (!docs.length) return 0
    await Contract.bulkWrite(
        docs.map(doc => ({
            updateOne: {
                filter: { id: doc.id },
                update: { $set: doc },
                upsert: true,
            },
        })),
        { ordered: false }
    )
    return docs.length
}

async function runFind(Contract, query, { skip, limit, sort, projection } = {}) {
    let cursor = projection
        ? Contract.find(query, projection)
        : Contract.find(query)
    if (sort) cursor = cursor.sort(sort)
    if (skip) cursor = cursor.skip(skip)
    if (limit) cursor = cursor.limit(limit)
    return cursor.lean()
}

async function liveNifLookup({
    nif,
    year,
    logger,
    fetchOfficial,
    Contract,
}) {
    const params = { nifEntidade: nif }
    if (year) params.ano = year
    const live = await fetchOfficial(params, { logger, timeout: LIVE_TIMEOUT_MS })
    if (live.disabled) return { source: 'local', warning: undefined }
    await upsertOfficial(live.records, Contract)
    return { source: 'live', warning: undefined }
}

async function maybeLiveFallback({
    nif,
    year,
    localCount,
    logger,
    Contract,
    fetchOfficial,
    getFreshness,
}) {
    const hasKey = hasOfficialApiKey()
    const freshness = await getFreshness()
    if (!shouldFetchLive({
        nif,
        localCount,
        lastSuccess: freshness.last_success,
        hasKey,
    })) {
        return { source: 'local' }
    }
    try {
        return await liveNifLookup({ nif, year, logger, fetchOfficial, Contract })
    } catch (err) {
        logger?.warn({ err, nif }, 'BASE V2 live fallback failed; returning local cache')
        return { source: 'local', warning: LIVE_WARNING }
    }
}

export async function listContracts({
    page = 1,
    limit = 25,
    type,
    year,
    nif,
    logger,
    Contract = ContractModel,
    fetchOfficial = fetchOfficialContracts,
    getFreshness = getSyncFreshness,
} = {}) {
    const nifNorm = nif == null || nif === '' ? null : normalizeNif(nif)
    if (nif != null && nif !== '' && !nifNorm) throw invalidNifError(nif)

    const query = buildListQuery({ type, year, nif: nifNorm })
    const skip = (page - 1) * limit

    let [data, total] = await Promise.all([
        runFind(Contract, query, { sort: { date: -1 }, skip, limit }),
        Contract.countDocuments(query),
    ])

    const live = await maybeLiveFallback({
        nif: nifNorm,
        year,
        localCount: total,
        logger,
        Contract,
        fetchOfficial,
        getFreshness,
    })

    if (live.source === 'live') {
        ;[data, total] = await Promise.all([
            runFind(Contract, query, { sort: { date: -1 }, skip, limit }),
            Contract.countDocuments(query),
        ])
    }

    return {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 0,
        source: live.source,
        ...(live.warning ? { warning: live.warning } : {}),
        data: data.map(toListItem),
    }
}

export async function searchContracts({
    q,
    nif,
    page = 1,
    limit = 25,
    logger,
    Contract = ContractModel,
    fetchOfficial = fetchOfficialContracts,
    getFreshness = getSyncFreshness,
} = {}) {
    const qTrim = q?.trim() ?? ''
    const nifParam = nif == null || nif === '' ? null : normalizeNif(nif)
    if (nif != null && nif !== '' && !nifParam) throw invalidNifError(nif)

    const nifFromQ = normalizeNif(qTrim)
    const nifNorm = nifParam || nifFromQ
    const textQ = nifFromQ && nifFromQ === qTrim ? '' : qTrim

    if (!textQ && !nifNorm) {
        const err = new Error('q or nif parameter is required')
        err.statusCode = 400
        throw err
    }

    const skip = (page - 1) * limit
    const { data, total, usedText } = await runSearch(Contract, { nifNorm, textQ, skip, limit })

    const live = await maybeLiveFallback({
        nif: nifNorm,
        year: undefined,
        localCount: total,
        logger,
        Contract,
        fetchOfficial,
        getFreshness,
    })

    const refreshed = live.source === 'live'
        ? await runSearch(Contract, { nifNorm, textQ, skip, limit })
        : { data, total, usedText }

    return {
        query: qTrim || nifNorm,
        total: refreshed.total,
        page,
        limit,
        pages: Math.ceil(refreshed.total / limit) || 0,
        source: live.source,
        ...(live.warning ? { warning: live.warning } : {}),
        data: refreshed.data.map(toListItem),
        ...(refreshed.usedText === 'regex' ? { search: 'regex' } : {}),
    }
}

async function runSearch(Contract, { nifNorm, textQ, skip, limit }) {
    if (!textQ) {
        const query = nifNorm ? nifClause(nifNorm) : {}
        const [data, total] = await Promise.all([
            runFind(Contract, query, { sort: { date: -1 }, skip, limit }),
            Contract.countDocuments(query),
        ])
        return { data, total, usedText: nifNorm ? 'nif' : 'none' }
    }

    const textQuery = { $text: { $search: textQ } }
    const query = nifNorm ? { $and: [nifClause(nifNorm), textQuery] } : textQuery

    try {
        const [data, total] = await Promise.all([
            runFind(Contract, query, {
                projection: { score: { $meta: 'textScore' } },
                sort: { score: { $meta: 'textScore' }, synced_at: -1 },
                skip,
                limit,
            }),
            Contract.countDocuments(query),
        ])
        return { data, total, usedText: 'text' }
    } catch {
        const re = new RegExp(escapeRegex(textQ), 'i')
        const regexQuery = {
            $or: [
                { description: re },
                { contractingEntity: re },
                { awarded: re },
            ],
        }
        const combined = nifNorm ? { $and: [nifClause(nifNorm), regexQuery] } : regexQuery
        const [data, total] = await Promise.all([
            runFind(Contract, combined, { sort: { synced_at: -1 }, skip, limit }),
            Contract.countDocuments(combined),
        ])
        return { data, total, usedText: 'regex' }
    }
}

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
