import { Contract } from './models/contract.js'
import { fetchBase } from './baseClient.js'
import { BASE_AUTH_HEADER, findContractRecord, mapOfficialContract, officialContractUrl } from './baseApi.js'

export async function baseRoutes(app) {

  // GET / (under /base prefix) — recent contracts, paginated (main entry point)
  app.get('/', {
    schema: {
      description: 'Recent public contracts from BASE.gov.pt',
      tags: ['Contracts'],
      querystring: {
        type: 'object',
        properties: {
          page:  { type: 'integer', default: 1, minimum: 1 },
          limit: { type: 'integer', default: 25, minimum: 1, maximum: 100 },
          type:  { type: 'string', description: 'Contract type (ajuste, concurso)' },
          year:  { type: 'integer', description: 'Filter by year (e.g. 2025)' }
        }
      }
    }
  }, async (req) => {
    const { page = 1, limit = 25, type, year } = req.query
    const skip = (page - 1) * limit

    const query = {}
    if (type) query.type = type
    if (year) query.date = { $regex: `^${year}-` }

    const [contracts, total] = await Promise.all([
      Contract.find(query).sort({ date: -1 }).skip(skip).limit(limit).lean(),
      Contract.countDocuments(query)
    ])

    return {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      data:  contracts.map(c => ({
        id:                c.id,
        description:       c.description,
        contractingEntity: c.contractingEntity,
        awarded:           c.awarded,
        value:             c.value,
        date:              c.date,
        type:              c.type,
        synced_at:         c.synced_at
      }))
    }
  })

  // GET /contracts — recent contracts, paginated
  app.get('/contracts', {
    schema: {
      description: 'Recent public contracts from BASE.gov.pt',
      tags: ['Contracts'],
      querystring: {
        type: 'object',
        properties: {
          page:  { type: 'integer', default: 1, minimum: 1 },
          limit: { type: 'integer', default: 25, minimum: 1, maximum: 100 },
          type:  { type: 'string', description: 'Contract type (ajuste, concurso)' },
          year:  { type: 'integer', description: 'Filter by year (e.g. 2025)' }
        }
      }
    }
  }, async (req) => {
    const { page = 1, limit = 25, type, year } = req.query
    const skip = (page - 1) * limit

    const query = {}
    if (type) query.type = type
    if (year) query.date = { $regex: `^${year}-` }

    const [contracts, total] = await Promise.all([
      Contract.find(query).sort({ date: -1 }).skip(skip).limit(limit).lean(),
      Contract.countDocuments(query)
    ])

    return {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      data:  contracts.map(c => ({
        id:                c.id,
        description:       c.description,
        contractingEntity: c.contractingEntity,
        awarded:           c.awarded,
        value:             c.value,
        date:              c.date,
        type:              c.type,
        synced_at:         c.synced_at
      }))
    }
  })

  // GET /contracts/search?q=termo
  app.get('/contracts/search', {
    schema: {
      description: 'Search public contracts by text',
      tags: ['Contracts'],
      querystring: {
        type: 'object',
        properties: {
          q:     { type: 'string', description: 'Search term' },
          page:  { type: 'integer', default: 1, minimum: 1 },
          limit: { type: 'integer', default: 25, minimum: 1, maximum: 100 }
        },
        required: ['q']
      }
    }
  }, async (req, reply) => {
    const { q, page = 1, limit = 25 } = req.query
    if (!q?.trim()) return reply.code(400).send({ error: 'q parameter is required' })

    const skip = (page - 1) * limit

    // Use MongoDB text index if available, otherwise regex fallback
    let query, sortOpt
    try {
      query   = { $text: { $search: q } }
      sortOpt = { score: { $meta: 'textScore' }, synced_at: -1 }

      const [contracts, total] = await Promise.all([
        Contract.find(query, { score: { $meta: 'textScore' } })
          .sort(sortOpt).skip(skip).limit(limit).lean(),
        Contract.countDocuments(query)
      ])

      return {
        query: q,
        total,
        page,
        limit,
        data: contracts.map(c => ({
          id:                c.id,
          description:       c.description,
          contractingEntity: c.contractingEntity,
          awarded:           c.awarded,
          value:             c.value,
          date:              c.date,
          type:              c.type
        }))
      }
    } catch {
      // Fallback to regex search
      const re = new RegExp(q, 'i')
      query = {
        $or: [
          { description: re },
          { contractingEntity: re },
          { awarded: re }
        ]
      }
      const [contracts, total] = await Promise.all([
        Contract.find(query).sort({ synced_at: -1 }).skip(skip).limit(limit).lean(),
        Contract.countDocuments(query)
      ])

      return {
        query: q,
        total,
        page,
        limit,
        data: contracts.map(c => ({
          id:                c.id,
          description:       c.description,
          contractingEntity: c.contractingEntity,
          awarded:           c.awarded,
          value:             c.value,
          date:              c.date,
          type:              c.type
        }))
      }
    }
  })

  // GET /contracts/lookup/:id — fetch from official BASE.gov.pt API (live)
  // Falls back to MongoDB if token not set or API unreachable
  app.get('/contracts/lookup/:id', {
    schema: {
      description: 'Contract detail from official BASE.gov.pt APIBase2-V2 (live). V1 /APIBase2 is discontinued on 2026-12-04.',
      tags: ['Contracts'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Contract ID (idContrato)' }
        },
        required: ['id']
      }
    }
  }, async (req) => {
    const { id } = req.params

    // Official API only when BASE_API_KEY is set in the environment
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

    // Fallback: return from MongoDB
    const contract = await Contract.findOne({ id: String(id) }).lean()
    if (!contract) {
      return { error: 'Contract not found', id }
    }
    return {
      source: 'mongodb',
      id:       contract.id,
      description:    contract.description,
      contractingEntity: contract.contractingEntity,
      awarded:        contract.awarded,
      value:          contract.value,
      date:           contract.date,
      type:           contract.type,
    }
  })
}
