import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    BASE_API_URL,
    BASE_AUTH_HEADER,
    findContractRecord,
    formatEntityLabel,
    mapOfficialContract,
    normalizeDate,
    officialContractUrl,
    officialContractsUrl,
    parseCpv,
    parseEntity,
    parseMoney,
    unwrapRecords,
} from '../src/baseApi.js'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const v2 = JSON.parse(readFileSync(resolve(fixtures, 'contrato-v2.json'), 'utf8'))
const v1 = JSON.parse(readFileSync(resolve(fixtures, 'contrato-v1.json'), 'utf8'))

describe('BASE API constants', () => {
    it('points at APIBase2-V2 and keeps the official auth typo', () => {
        assert.equal(BASE_API_URL, 'https://www.base.gov.pt/APIBase2V2')
        assert.equal(BASE_AUTH_HEADER, '_AcessToken')
        assert.equal(
            officialContractUrl('12345'),
            'https://www.base.gov.pt/APIBase2V2/GetInfoContrato?idContrato=12345'
        )
        assert.ok(!BASE_API_URL.includes('/APIBase2/'))
        assert.ok(!officialContractUrl(1).includes('/APIBase2/'))
        assert.match(officialContractsUrl({ nifEntidade: '519459369' }), /nifEntidade=519459369/)
    })

    it('does not hardcode the discontinued V1 URL in runtime entry points', () => {
        const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
        for (const rel of ['src/routes.js', 'src/baseApi.js', 'scripts/check-base.js']) {
            const source = readFileSync(resolve(root, rel), 'utf8')
            assert.equal(source.includes('https://www.base.gov.pt/APIBase2/'), false, rel)
            assert.equal(source.includes("https://www.base.gov.pt/APIBase2'"), false, rel)
        }
    })
})

describe('normalizeDate', () => {
    it('keeps V2 yyyy-MM-dd and converts legacy DD/MM/YYYY', () => {
        assert.equal(normalizeDate('2015-04-18'), '2015-04-18')
        assert.equal(normalizeDate('18/04/2015'), '2015-04-18')
        assert.equal(normalizeDate(''), null)
        assert.equal(normalizeDate('NULL'), null)
        assert.equal(normalizeDate(null), null)
    })
})

describe('parseMoney', () => {
    it('accepts V2 dotted decimals and leftover comma amounts', () => {
        assert.equal(parseMoney(105000.00), 105000)
        assert.equal(parseMoney('105000.00'), 105000)
        assert.equal(parseMoney('110000,00'), 110000)
        assert.equal(parseMoney('1.100.000,50'), 1100000.5)
        assert.equal(parseMoney('1,100,000.50'), 1100000.5)
        assert.equal(parseMoney('NULL'), null)
        assert.equal(parseMoney(''), null)
    })
})

describe('unwrapRecords / findContractRecord', () => {
    it('accepts a single object or an array payload', () => {
        assert.equal(unwrapRecords(v2).length, 1)
        assert.equal(unwrapRecords([v2, v1]).length, 2)
        assert.deepEqual(unwrapRecords(null), [])
        assert.equal(findContractRecord(v2, '12345').idcontrato, '12345')
        assert.equal(findContractRecord([v1], '12345').idContrato, '12345')
        assert.equal(findContractRecord({ error: 'nope' }, '12345'), null)
    })
})

describe('parseEntity / parseCpv', () => {
    it('parses V2 objects and V1 concatenated strings', () => {
        const entity = parseEntity(v2.adjudicante[0])
        assert.equal(entity.nif, '501501501')
        assert.equal(entity.name, 'Instituto de Teste, EPE')
        assert.equal(entity.countryCode, 'PRT')
        assert.equal(entity.nutsCode, 'PT16E')
        assert.equal(entity.label, '501501501 - Instituto de Teste, EPE')

        const legacy = parseEntity('654123987 - Entidade de Exemplo')
        assert.equal(legacy.nif, '654123987')
        assert.equal(legacy.name, 'Entidade de Exemplo')
        assert.equal(formatEntityLabel(legacy), '654123987 - Entidade de Exemplo')

        const missingNif = parseEntity({
            nifEntContrato: '',
            descEntContrato: 'Foreign Supplier Ltd',
            codPaisEntContrato: 'ESP',
        })
        assert.equal(missingNif.nif, null)
        assert.equal(missingNif.label, 'Foreign Supplier Ltd')

        const cpv = parseCpv(v2.CPV[0])
        assert.equal(cpv.id, '45212410-3')
        assert.equal(cpv.role, 'Principal')
        assert.equal(cpv.value, 110000)
        assert.equal(cpv.label, '45212410-3 - Obras de construção de edifícios relacionados com alojamento')

        const legacyCpv = parseCpv('45212410-3 - Obras de construção')
        assert.equal(legacyCpv.id, '45212410-3')
        assert.equal(legacyCpv.description, 'Obras de construção')
    })
})

describe('mapOfficialContract V2', () => {
    it('keeps readable public strings and exposes structured V2 fields', () => {
        const mapped = mapOfficialContract(v2)
        assert.equal(mapped.source, 'official')
        assert.equal(mapped.id, '12345')
        assert.equal(mapped.description, 'Contrato de teste')
        assert.equal(mapped.contractingEntity, '501501501 - Instituto de Teste, EPE')
        assert.equal(mapped.awarded, '500500500 - Fornecedor de teste, S.A.')
        assert.equal(mapped.value, 105000)
        assert.equal(mapped.date, '2015-04-18')
        assert.equal(mapped.type, 'Concurso público')
        assert.deepEqual(mapped.cpv, [
            '45212410-3 - Obras de construção de edifícios relacionados com alojamento',
        ])
        assert.equal(mapped.cpvs[0].id, '45212410-3')
        assert.equal(mapped.cpvs[0].role, 'Principal')
        assert.equal(mapped.primaryCpv, mapped.cpv[0])
        assert.equal(mapped.contractingEntities[0].nuts, 'Região de Coimbra')
        assert.equal(mapped.awardedEntities[0].sme, 'Sim')
        assert.equal(mapped.isSmeSubcontract, 'Sim')
        assert.equal(mapped.basePrice, 110000)
        assert.equal(mapped.estimatedProcedurePrice, 100000)
        assert.equal(mapped.effectivePrice, 105000)
        assert.equal(mapped.executionDays, 365)
        assert.equal(mapped.year, 2015)
        assert.equal(mapped.frameworkAgreement, null)
        assert.equal(mapped.announcementId, '432109')
        assert.equal(mapped.jointPurchase, 'Não')
        assert.equal(mapped.specialProcurementType, null)
        assert.equal(mapped.deadlineChangeCauses, 'Não houve alteração ao prazo de execução da obra.')
        assert.equal(mapped.priceChangeCauses, 'Não houve alteração ao valor da obra.')
        assert.equal(mapped.contractStatus, null)
        assert.equal(mapped.hasOccurrences, false)
        assert.equal(mapped.lots[0].name, 'Mesas')
        assert.equal(mapped.lots[0].criterionWeight, 5)
        assert.equal(mapped.lots[0].proposals, 2)
        assert.equal(mapped.invitedEntities.length, 2)
        assert.equal(mapped.invitedEntities[0].nif, '500045698')
        assert.equal(mapped.invitedEntities[0].country, 'Portugal')
        assert.deepEqual(mapped.competitors, [
            '500045698 - Empresa de Testes',
            '500123698 - Outra Empresa de Testes',
        ])
    })

    it('maps a V2 payload wrapped in an array and mixed HTML-example casing', () => {
        const htmlShape = {
            idContrato: '99',
            objectoContrato: 'Obra',
            adjudicante: [v2.adjudicante[0]],
            adjudicatarios: [v2.adjudicatarios[0]],
            dataCelebracaoContrato: '18/04/2015',
            precoContratual: '105000.00',
            cpv: v2.CPV,
            Ocorrencias: true,
            precoBaseProcedimento: '110000,00',
        }
        const mapped = mapOfficialContract(findContractRecord([htmlShape], '99'))
        assert.equal(mapped.id, '99')
        assert.equal(mapped.date, '2015-04-18')
        assert.equal(mapped.hasOccurrences, true)
        assert.equal(mapped.basePrice, 110000)
        assert.equal(mapped.contractingEntity, '501501501 - Instituto de Teste, EPE')
    })
})

describe('mapOfficialContract V1 fallback', () => {
    it('still reads concatenated adjudicante / adjudicatarios / cpv strings', () => {
        const mapped = mapOfficialContract(v1)
        assert.equal(mapped.id, '12345')
        assert.equal(mapped.contractingEntity, '501501501 - Instituto de Teste, EPE')
        assert.equal(mapped.awarded, '500500500 - Fornecedor de teste, S.A.')
        assert.equal(mapped.value, 105000)
        assert.equal(mapped.date, '2015-04-18')
        assert.equal(mapped.publicationDate, '2015-05-12')
        assert.equal(mapped.awardDate, '2015-03-15')
        assert.deepEqual(mapped.cpv, [
            '45212410-3 - Obras de construção de edifícios relacionados com alojamento',
        ])
        assert.equal(mapped.awardCriterion, 'Melhor relação qualidade – preço')
        assert.equal(mapped.effectivePrice, 0)
        assert.equal(mapped.lots, null)
        assert.equal(mapped.invitedEntities, null)
        assert.equal(mapped.contractingEntities[0].nif, '501501501')
    })

    it('returns null when the record has no contract id', () => {
        assert.equal(mapOfficialContract(null), null)
        assert.equal(mapOfficialContract({ objectoContrato: 'x' }), null)
    })
})
