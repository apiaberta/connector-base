import { nifsFromDoc } from './nifs.js'

/**
 * Official Portal BASE API (APIBase2-V2).
 *
 * V1 (`/APIBase2`) is discontinued on 2026-12-04.
 * Auth header remains `_AcessToken` (official typo).
 *
 * Field schemas follow DocAPIBase2V2 (authoritative). Live docs HTML examples
 * are sloppy (mixed date formats, `cpv` vs `CPV`, object vs array payload);
 * parsers accept both.
 */

export const BASE_API_URL = 'https://www.base.gov.pt/APIBase2V2'
export const BASE_AUTH_HEADER = '_AcessToken'

const ENTITY_NIF_KEYS = ['nifEntContrato', 'NIPCEntidade', 'nifEntidade']
const ENTITY_NAME_KEYS = ['descEntContrato', 'Entidade', 'desigEntidade', 'designacaoEntidade']

export function emptyToNull(value) {
    if (value == null) return null
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed || trimmed.toUpperCase() === 'NULL') return null
        return trimmed
    }
    return value
}

export function pickField(obj, ...names) {
    if (!obj || typeof obj !== 'object') return undefined
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(obj, name) && obj[name] !== undefined) {
            return obj[name]
        }
    }
    const lower = new Map()
    for (const [key, value] of Object.entries(obj)) {
        lower.set(key.toLowerCase(), value)
    }
    for (const name of names) {
        if (lower.has(name.toLowerCase())) return lower.get(name.toLowerCase())
    }
    return undefined
}

// DD/MM/YYYY (legacy V1 / HTML examples) or yyyy-MM-dd (V2 PDF)
export function normalizeDate(value) {
    const raw = emptyToNull(value)
    if (!raw) return null
    const text = String(raw)
    const dmy = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
    return text
}

export function parseMoney(value) {
    if (value == null || value === '') return null
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    const text = String(value).trim()
    if (!text || text.toUpperCase() === 'NULL') return null

    let normalized = text.replace(/\s/g, '')
    if (normalized.includes(',') && normalized.includes('.')) {
        const lastComma = normalized.lastIndexOf(',')
        const lastDot = normalized.lastIndexOf('.')
        normalized = lastComma > lastDot
            ? normalized.replace(/\./g, '').replace(',', '.')
            : normalized.replace(/,/g, '')
    } else if (normalized.includes(',')) {
        normalized = normalized.replace(',', '.')
    }

    const parsed = parseFloat(normalized.replace(/[^\d.+-]/g, ''))
    return Number.isFinite(parsed) ? parsed : null
}

export function parseIntish(value) {
    if (value == null || value === '') return null
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    const text = emptyToNull(value)
    if (!text) return null
    const parsed = parseInt(String(text), 10)
    return Number.isFinite(parsed) ? parsed : null
}

export function parseBool(value) {
    if (value == null || value === '') return null
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    const text = String(value).trim().toLowerCase()
    if (['true', '1', 'sim', 'yes'].includes(text)) return true
    if (['false', '0', 'nao', 'não', 'no'].includes(text)) return false
    return null
}

export function unwrapRecords(payload) {
    if (payload == null) return []
    if (Array.isArray(payload)) {
        return payload.filter(item => item && typeof item === 'object' && !Array.isArray(item))
    }
    if (typeof payload === 'object') {
        for (const key of ['contratos', 'Contratos', 'data', 'Data', 'results', 'Results']) {
            if (Array.isArray(payload[key])) return unwrapRecords(payload[key])
        }
        return [payload]
    }
    return []
}

export function firstOf(value) {
    if (Array.isArray(value)) {
        for (const item of value) {
            const text = emptyToNull(item)
            if (text) return text
        }
        return null
    }
    return emptyToNull(value)
}

export function normalizeList(value) {
    if (value == null) return null
    if (typeof value === 'string') {
        const text = emptyToNull(value)
        return text ? [text] : null
    }
    if (!Array.isArray(value)) return null
    const items = value.map(emptyToNull).filter(item => item != null && item !== '')
    return items.length ? items : null
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined) return value
    }
    return undefined
}

export function formatEntityLabel(entity) {
    if (entity == null) return null
    if (typeof entity === 'string') return emptyToNull(entity)
    const nif = emptyToNull(firstDefined(...ENTITY_NIF_KEYS.map(k => entity[k]), entity.nif))
    const name = emptyToNull(firstDefined(...ENTITY_NAME_KEYS.map(k => entity[k]), entity.name))
    if (nif && name) return `${nif} - ${name}`
    return name || nif || emptyToNull(entity.label) || null
}

export function parseEntity(raw) {
    if (raw == null) return null
    if (typeof raw === 'string') {
        const label = emptyToNull(raw)
        if (!label) return null
        const match = label.match(/^(\d+)\s*-\s*(.+)$/)
        return {
            nif: match ? match[1] : null,
            name: match ? match[2] : label,
            countryCode: null,
            nutsCode: null,
            nuts: null,
            sme: null,
            type: null,
            activity: null,
            label,
        }
    }
    if (typeof raw !== 'object') return null

    const nif = emptyToNull(firstDefined(
        raw.nifEntContrato,
        raw.NIPCEntidade,
        raw.nifEntidade
    ))
    const name = emptyToNull(firstDefined(
        raw.descEntContrato,
        raw.Entidade,
        raw.desigEntidade,
        raw.designacaoEntidade
    ))
    const label = formatEntityLabel(raw)
    if (!label) return null

    return {
        nif,
        name,
        countryCode: emptyToNull(firstDefined(raw.codPaisEntContrato, raw.AliasPais)),
        nutsCode: emptyToNull(raw.NUTsCod),
        nuts: emptyToNull(raw.NUTsDesc),
        sme: emptyToNull(raw.adjudicatarioPME),
        type: emptyToNull(raw.tipoEntidade),
        activity: emptyToNull(raw.atividadeEntidade),
        label,
    }
}

export function parseEntities(raw) {
    if (raw == null) return []
    const list = Array.isArray(raw) ? raw : [raw]
    return list.map(parseEntity).filter(Boolean)
}

export function formatCpvLabel(cpv) {
    if (cpv == null) return null
    if (typeof cpv === 'string') return emptyToNull(cpv)
    const id = emptyToNull(cpv.cpvID)
    const description = emptyToNull(cpv.cpvdescricao)
    if (id && description) return `${id} - ${description}`
    return id || description || null
}

export function parseCpv(raw) {
    if (raw == null) return null
    if (typeof raw === 'string') {
        const label = emptyToNull(raw)
        if (!label) return null
        const match = label.match(/^([0-9]{8}(?:-\d)?)\s*-\s*(.+)$/)
        return {
            id: match ? match[1] : null,
            description: match ? match[2] : label,
            value: null,
            role: null,
            label,
        }
    }
    if (typeof raw !== 'object') return null

    const id = emptyToNull(raw.cpvID)
    const description = emptyToNull(raw.cpvdescricao)
    const label = formatCpvLabel(raw)
    if (!label) return null

    return {
        id,
        description,
        value: parseMoney(raw.cpvValor),
        role: emptyToNull(raw.CPVObjeto),
        label,
    }
}

export function parseCpvs(raw) {
    if (raw == null) return []
    const list = Array.isArray(raw) ? raw : [raw]
    return list.map(parseCpv).filter(Boolean)
}

export function parseInvitedEntity(raw) {
    if (raw == null) return null
    if (typeof raw === 'string') {
        const parsed = parseEntity(raw)
        if (!parsed) return null
        return {
            nif: parsed.nif,
            name: parsed.name,
            countryCode: parsed.countryCode,
            country: parsed.country || null,
            label: parsed.label,
        }
    }
    if (typeof raw !== 'object') return null

    const nif = emptyToNull(raw.NIPCEntidade)
    const name = emptyToNull(raw.Entidade)
    const countryCode = emptyToNull(raw.AliasPais)
    const country = emptyToNull(raw.Pais)
    const label = nif && name ? `${nif} - ${name}` : (name || nif)
    if (!label) return null

    return { nif, name, countryCode, country, label }
}

export function parseInvitedEntities(raw) {
    if (raw == null) return []
    const list = Array.isArray(raw) ? raw : [raw]
    return list.map(parseInvitedEntity).filter(Boolean)
}

export function parseLot(raw) {
    if (!raw || typeof raw !== 'object') return null
    const lot = {
        lotNumber: emptyToNull(raw.numLot),
        name: emptyToNull(raw.designacaoLote),
        description: emptyToNull(raw.descricaoLote),
        criterion: emptyToNull(raw.criterioLote),
        criterionWeight: parseMoney(firstDefined(
            raw.criterioAdjudicacaoPonderacao,
            raw.criterioLotePercentagem
        )),
        awardCriterionType: emptyToNull(firstDefined(
            raw.criterioAdjudicacaoTipo,
            raw.criterioAquisicaoTipo
        )),
        awardCriterionFactorType: emptyToNull(firstDefined(
            raw.criterioAdjudicacaoTipoFator,
            raw.criterioAquisicaoTipoFator
        )),
        awardCriterionFactor: emptyToNull(firstDefined(
            raw.criterioAdjudicacaoFator,
            raw.criterioAquisicaoPonderacao
        )),
        proposals: parseIntish(raw.NumPropostas),
        baseValue: parseMoney(raw.valorBaseLote),
        cpvId: emptyToNull(raw.cpvAliasId),
        cpvDescription: emptyToNull(raw.cpvDescription),
    }
    return Object.values(lot).some(value => value != null) ? lot : null
}

export function parseLots(raw) {
    if (raw == null) return []
    const list = Array.isArray(raw) ? raw : [raw]
    return list.map(parseLot).filter(Boolean)
}

export function findContractRecord(payload, id) {
    const records = unwrapRecords(payload)
    if (id != null && id !== '') {
        const want = String(id)
        return records.find(record => {
            const recordId = pickField(record, 'idcontrato', 'idContrato')
            return recordId != null && String(recordId) === want
        }) ?? null
    }
    return records[0] ?? null
}

function orNull(list) {
    return list.length ? list : null
}

export function mapOfficialContract(raw) {
    if (!raw || typeof raw !== 'object') return null

    const id = pickField(raw, 'idcontrato', 'idContrato')
    if (id == null || id === '') return null

    const contracting = parseEntities(pickField(raw, 'adjudicante'))
    const awarded = parseEntities(pickField(raw, 'adjudicatarios'))
    const cpvs = parseCpvs(pickField(raw, 'cpv', 'CPV'))
    const invited = parseInvitedEntities(pickField(raw, 'entidadesConvidadas'))
    const lots = parseLots(pickField(raw, 'Lotes', 'lotes'))

    const primaryCpv = cpvs.find(cpv => /principal/i.test(cpv.role || '')) || cpvs[0] || null
    const sme = awarded.find(entity => entity.sme)?.sme
        ?? emptyToNull(pickField(raw, 'adjudicatarioPMEs'))

    return {
        source: 'official',
        id: String(id),
        description: emptyToNull(pickField(raw, 'objectoContrato'))
            || emptyToNull(pickField(raw, 'descContrato')),
        contractingEntity: contracting[0]?.label || null,
        awarded: awarded[0]?.label || null,
        value: parseMoney(pickField(raw, 'precoContratual')),
        date: normalizeDate(pickField(raw, 'dataCelebracaoContrato')),
        type: emptyToNull(pickField(raw, 'tipoprocedimento')),
        announcementNumber: emptyToNull(pickField(raw, 'nAnuncio')),
        announcementId: emptyToNull(pickField(raw, 'IDAnuncio')),
        announcementType: emptyToNull(pickField(raw, 'TipoAnuncio')),
        // V1 returned concatenated "code - description" strings; keep that shape.
        cpv: orNull(cpvs.map(item => item.label)),
        cpvs: orNull(cpvs),
        executionPlace: normalizeList(pickField(raw, 'localExecucao')),
        Nuts: normalizeList(pickField(raw, 'NUTs')),
        basePrice: parseMoney(pickField(raw, 'precoBaseProcedimento')),
        estimatedProcedurePrice: parseMoney(pickField(raw, 'precoEstimadoProc')),
        awardDate: normalizeDate(pickField(raw, 'dataDecisaoAdjudicacao')),
        competitors: normalizeList(pickField(raw, 'concorrentes')),
        contractCloseDate: normalizeDate(pickField(raw, 'dataFechoContrato')),
        effectivePrice: parseMoney(pickField(raw, 'PrecoTotalEfetivo')),
        regime: emptyToNull(pickField(raw, 'regime')),
        contractType: firstOf(pickField(raw, 'tipoContrato')),
        justificationDirect: emptyToNull(pickField(raw, 'fundamentAjusteDireto')),
        legalBasis: emptyToNull(pickField(raw, 'fundamentacao')),
        awardCriterion: emptyToNull(pickField(raw, 'TipoCriterioAdjudicacao')),
        publicationDate: normalizeDate(pickField(raw, 'dataPublicacao')),
        executionDays: parseIntish(pickField(raw, 'prazoExecucao')),
        frameworkAgreement: emptyToNull(pickField(raw, 'numAcordoQuadro')),
        isCentralized: emptyToNull(pickField(raw, 'ProcedimentoCentralizado')),
        isEcological: emptyToNull(pickField(raw, 'ContratEcologico')),
        isSmeSubcontract: sme || null,
        lots: orNull(lots),
        year: parseIntish(pickField(raw, 'Ano')),
        contractingEntities: orNull(contracting),
        awardedEntities: orNull(awarded),
        jointPurchase: emptyToNull(pickField(raw, 'compraConjunta')),
        specialProcurementType: emptyToNull(pickField(raw, 'TipoMEC')),
        invitedEntities: orNull(invited),
        deadlineChangeCauses: emptyToNull(pickField(raw, 'CausasAlteraPrazo')),
        priceChangeCauses: emptyToNull(pickField(raw, 'CausasAlteraPreco')),
        contractStatus: emptyToNull(pickField(raw, 'estadoContrato')),
        hasOccurrences: parseBool(pickField(raw, 'ocorrencias', 'Ocorrencias')),
        primaryCpv: primaryCpv?.label || null,
    }
}

export function officialContractUrl(idContrato) {
    return officialContractsUrl({ idContrato })
}

/**
 * Build GetInfoContrato URL. V2 requires at least one of: idContrato,
 * IdProcedimento, nifEntidade, nAnuncio, numAcordoQuadro, numDias (max 90), Ano.
 * There is no free-text search and no from/to date range.
 */
export function officialContractsUrl({
    idContrato,
    idProcedimento,
    nifEntidade,
    nAnuncio,
    numAcordoQuadro,
    numDias,
    ano,
} = {}) {
    const qs = new URLSearchParams()
    if (idContrato != null && idContrato !== '') qs.set('idContrato', String(idContrato))
    if (idProcedimento != null && idProcedimento !== '') qs.set('IdProcedimento', String(idProcedimento))
    if (nifEntidade) qs.set('nifEntidade', String(nifEntidade))
    if (nAnuncio) qs.set('nAnuncio', String(nAnuncio))
    if (numAcordoQuadro) qs.set('numAcordoQuadro', String(numAcordoQuadro))
    if (numDias != null && numDias !== '') qs.set('numDias', String(numDias))
    if (ano != null && ano !== '') qs.set('Ano', String(ano))
    const query = qs.toString()
    return query ? `${BASE_API_URL}/GetInfoContrato?${query}` : `${BASE_API_URL}/GetInfoContrato`
}

export function assertOfficialPayload(payload) {
    if (payload == null) return payload
    if (typeof payload === 'string') {
        const text = payload.trim()
        if (/invalid token|token is required|error/i.test(text)) {
            throw new Error(text.slice(0, 400))
        }
        throw new Error(`Unexpected BASE API text response: ${text.slice(0, 200)}`)
    }
    if (typeof payload === 'object' && !Array.isArray(payload)) {
        const errMsg = payload.error ?? payload.Error ?? payload.mensagem
        const hasId = pickField(payload, 'idcontrato', 'idContrato')
        if (errMsg && hasId == null) throw new Error(String(errMsg).slice(0, 400))
    }
    return payload
}

export function toCacheDocument(mapped, { syncedAt = new Date() } = {}) {
    if (!mapped?.id) return null
    const { contractingNifs, awardedNifs } = nifsFromDoc({
        contractingEntity: mapped.contractingEntity,
        awarded: mapped.awarded,
        contractingEntities: mapped.contractingEntities,
        awardedEntities: mapped.awardedEntities,
    })
    return {
        id: mapped.id,
        description: mapped.description ?? '',
        contractingEntity: mapped.contractingEntity ?? '',
        awarded: mapped.awarded ?? '',
        value: mapped.value ?? 0,
        date: mapped.date ?? null,
        type: mapped.type ?? 'unknown',
        ano: mapped.year ?? null,
        nAnuncio: mapped.announcementNumber ?? '',
        contractingNifs,
        awardedNifs,
        nifsBackfilled: true,
        synced_at: syncedAt,
    }
}
