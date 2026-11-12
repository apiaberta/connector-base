import { fetchBase, DEFAULT_BASE_TIMEOUT_MS } from './baseClient.js'
import {
    BASE_AUTH_HEADER,
    assertOfficialPayload,
    mapOfficialContract,
    officialContractsUrl,
    unwrapRecords,
} from './baseApi.js'

export function hasOfficialApiKey() {
    return Boolean(process.env.BASE_API_KEY?.trim())
}

/**
 * Query APIBase2-V2 GetInfoContrato. Disabled (no throw) when BASE_API_KEY
 * is unset. Tests inject `fetchFn` so the real host is never contacted.
 */
export async function fetchOfficialContracts(params = {}, {
    fetchFn = fetchBase,
    timeout = DEFAULT_BASE_TIMEOUT_MS,
    logger,
    apiKey = process.env.BASE_API_KEY?.trim(),
} = {}) {
    if (!apiKey) return { disabled: true, records: [] }

    const url = officialContractsUrl(params)
    const res = await fetchFn(url, {
        headers: { [BASE_AUTH_HEADER]: apiKey },
        timeout,
    }, logger)

    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`BASE API HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }

    let payload
    try {
        payload = await res.json()
    } catch (err) {
        throw new Error(`BASE API returned non-JSON: ${err.message}`)
    }

    assertOfficialPayload(payload)
    const records = unwrapRecords(payload)
        .map(mapOfficialContract)
        .filter(Boolean)
    return { disabled: false, records }
}
