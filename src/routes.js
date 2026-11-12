import { Contract } from './models/contract.js'
import { fetchBase } from './baseClient.js'
import { BASE_AUTH_HEADER, findContractRecord, mapOfficialContract, officialContractUrl } from './baseApi.js'
import { listContracts, searchContracts } from './contractsService.js'
import { LOOKUP_PROJECTION, QUERY_MAX_TIME_MS } from './queryLimits.js'

const nifQuery = {
    type: 'string',
    pattern: '^[0-9]{9}$',
    description: 'Portuguese NIF (9 digits). Matches contracting entity or awarded supplier.',
}

const listQuerystring = {
    type: 'object',
    properties: {
        page: { type: 'integer', default: 1, minimum: 1 },
        limit: { type: 'integer', default: 25, minimum: 1, maximum: 100 },
        type: { type: 'string', description: 'Contract type (ajuste, concurso)' },
        year: { type: 'integer', description: 'Filter by year (e.g. 2026)' },
        nif: nifQuery,
    },
}

const listItem = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        description: { type: ['string', 'null'] },
        contractingEntity: { type: ['string', 'null'] },
        awarded: { type: ['string', 'null'] },
        value: { type: ['number', 'null'] },
        date: { type: ['string', 'null'] },
        type: { type: ['string', 'null'] },
        synced_at: { type: ['string', 'null'], format: 'date-time' },
    },
}

const listResponse = {
    type: 'object',
    properties: {
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
        pages: { type: 'integer' },
        source: { type: 'string', enum: ['local', 'live'] },
        warning: { type: 'string', description: 'Present when V2 failed and local cache was returned' },
        data: { type: 'array', items: listItem },
    },
}

function sendError(reply, err) {
    if (err.statusCode) {
        return reply.code(err.statusCode).send({ error: err.message })
    }
    throw err
}

export async function baseRoutes(app, opts = {}) {
    const list = opts.listContracts ?? listContracts
    const search = opts.searchContracts ?? searchContracts

    app.get('/', {
        schema: {
            description: 'Recent public contracts from BASE.gov.pt',
            tags: ['Contracts'],
            querystring: listQuerystring,
            response: { 200: listResponse },
        },
    }, async (req, reply) => {
        try {
            return await list({ ...req.query, logger: req.log })
        } catch (err) {
            return sendError(reply, err)
        }
    })

    app.get('/contracts', {
        schema: {
            description: 'Paginated public contracts. Filter by nif (9 digits) on contracting entity or awarded supplier. When local data is missing or last_success is older than 48h, falls back to APIBase2-V2 (nifEntidade) if BASE_API_KEY is set.',
            tags: ['Contracts'],
            querystring: listQuerystring,
            response: { 200: listResponse },
        },
    }, async (req, reply) => {
        try {
            return await list({ ...req.query, logger: req.log })
        } catch (err) {
            return sendError(reply, err)
        }
    })

    app.get('/contracts/search', {
        schema: {
            description: 'Search public contracts by text and/or NIF. Text search uses a date window (default last 365 days; override with from/to/year), maxTimeMS, and limit ≤ 100. V2 has no free-text search; live fallback is used only for NIF queries.',
            tags: ['Contracts'],
            querystring: {
                type: 'object',
                properties: {
                    q: { type: 'string', description: 'Search term (9-digit NIF is routed to the nif index)' },
                    nif: nifQuery,
                    page: { type: 'integer', default: 1, minimum: 1 },
                    limit: { type: 'integer', default: 25, minimum: 1, maximum: 100 },
                    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Text-search start date (YYYY-MM-DD). Default: today minus SEARCH_WINDOW_DAYS.' },
                    to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Text-search end date (YYYY-MM-DD). Default: today.' },
                    year: { type: 'integer', description: 'Restrict text search to a calendar year (YYYY-MM-DD range on the date index)' },
                },
                anyOf: [{ required: ['q'] }, { required: ['nif'] }],
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        total: { type: 'integer' },
                        page: { type: 'integer' },
                        limit: { type: 'integer' },
                        pages: { type: 'integer' },
                        source: { type: 'string', enum: ['local', 'live'] },
                        warning: { type: 'string' },
                        data: { type: 'array', items: listItem },
                    },
                },
            },
        },
    }, async (req, reply) => {
        try {
            return await search({ ...req.query, logger: req.log })
        } catch (err) {
            return sendError(reply, err)
        }
    })

    app.get('/contracts/lookup/:id', {
        schema: {
            description: 'Contract detail from official BASE.gov.pt APIBase2-V2 (live). V1 /APIBase2 is discontinued on 2026-12-04.',
            tags: ['Contracts'],
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Contract ID (idContrato)' },
                },
                required: ['id'],
            },
        },
    }, async (req) => {
        const { id } = req.params

        const baseApiKey = process.env.BASE_API_KEY?.trim()
        if (!baseApiKey) {
            req.log.warn({ id }, 'BASE_API_KEY is not set; official API enrichment skipped, falling back to cached XLSX/MongoDB data')
        } else {
            try {
                const res = await fetchBase(
                    officialContractUrl(id),
                    { headers: { [BASE_AUTH_HEADER]: baseApiKey } },
                    req.log
                )
                if (res.ok) {
                    const mapped = mapOfficialContract(findContractRecord(await res.json(), id))
                    if (mapped) return mapped
                    req.log.warn({ id, status: res.status }, 'BASE official API returned no contract; falling back to cached XLSX/MongoDB data')
                } else {
                    req.log.warn({ id, status: res.status }, 'BASE official API HTTP error; falling back to cached XLSX/MongoDB data')
                }
            } catch (err) {
                req.log.warn({ err, id }, 'BASE official API lookup failed; falling back to cached XLSX/MongoDB data')
            }
        }

        let lookup = Contract.findOne({ id: String(id) }, LOOKUP_PROJECTION)
        if (typeof lookup.maxTimeMS === 'function') lookup = lookup.maxTimeMS(QUERY_MAX_TIME_MS)
        const contract = await lookup.lean()
        if (!contract) {
            return { error: 'Contract not found', id }
        }
        return {
            source: 'mongodb',
            id: contract.id,
            description: contract.description,
            contractingEntity: contract.contractingEntity,
            awarded: contract.awarded,
            value: contract.value,
            date: contract.date,
            type: contract.type,
        }
    })
}
