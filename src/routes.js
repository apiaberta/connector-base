import { Contract } from './models/contract.js'

export async function baseRoutes(app) {

  // GET /base — recent contracts, paginated (main entry point)
  app.get('/base', {
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
}
