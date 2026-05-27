import { Contract } from './models/contract.js'

// DD/MM/YYYY → YYYY-MM-DD
function normalizeDate(d) {
  if (!d) return null
  const m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  return String(d)
}

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
      description: 'Contract detail from official BASE.gov.pt API (live)',
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
    const BASE_URL = 'https://www.base.gov.pt/APIBase2'

    // Try official API first
    if (process.env.BASE_API_KEY) {
      try {
        const res = await fetch(
          `${BASE_URL}/GetInfoContrato?idContrato=${encodeURIComponent(id)}`,
          { headers: { '_AcessToken': process.env.BASE_API_KEY } }
        )
        if (res.ok) {
          const [data] = await res.json()
          if (data && data.idcontrato) {
            return {
              source:   'official',
              id:       data.idcontrato,
              description: data.objectoContrato || data.descContrato,
              contractingEntity: (data.adjudicante || [])[0] || null,
              awarded:  (data.adjudicatarios || [])[0] || null,
              value:    typeof data.precoContratual === 'number' ? data.precoContratual
                       : parseFloat(String(data.precoContratual || '0').replace(',', '.')) || null,
              date:     normalizeDate(data.dataCelebracaoContrato),
              type:     data.tipoprocedimento || null,
              // ── Official API enrichment fields ──
              announcementNumber: data.nAnuncio || null,
              cpv:              data.cpv || null,
              executionPlace:   data.localExecucao || null,
              Nuts:             data.NUTs || null,
              basePrice:        typeof data.precoBaseProcedimento === 'number' ? data.precoBaseProcedimento
                               : parseFloat(String(data.precoBaseProcedimento || '0').replace(',', '.')) || null,
              awardDate:        normalizeDate(data.dataDecisaoAdjudicacao),
              competitors:      data.concorrentes || null,
              contractCloseDate: normalizeDate(data.dataFechoContrato),
              effectivePrice:   typeof data.PrecoTotalEfetivo === 'number' ? data.PrecoTotalEfetivo
                               : parseFloat(String(data.PrecoTotalEfetivo || '0').replace(',', '.')) || null,
              regime:           data.regime || null,
              contractType:     (data.tipoContrato || [])[0] || null,
              justificationDirect: data.fundamentAjusteDireto || null,
              legalBasis:       data.fundamentacao || null,
              awardCriterion:   data.TipoCriterioAdjudicacao || null,
              publicationDate:  normalizeDate(data.dataPublicacao),
              executionDays:    data.prazoExecucao || null,
              frameworkAgreement: data.numAcordoQuadro || null,
              isCentralized:    data.ProcedimentoCentralizado || null,
              isEcological:     data.ContratEcologico || null,
              isSmeSubcontract: data.adjudicatarioPMEs || null,
              lots:             data.Lotes || null,
              year:             data.Ano || null,
            }
          }
        }
      } catch (err) {
        req.log.warn({ err, id }, 'BASE official API lookup failed, falling back to MongoDB')
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
