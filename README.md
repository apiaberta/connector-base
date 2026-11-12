# API Aberta — Public Contracts Connector (BASE)

Portuguese public procurement data from BASE.gov.pt.

## Features

- Search public contracts (text and NIF), bounded so MongoDB stays light
- Contract details with official API enrichment via APIBase2-V2
- Live NIF fallback when the local cache is empty or stale (>48h)
- Daily incremental sync via APIBase2-V2 (`numDias`, capped at 7 days per request)
- Bulk / catch-up from dados.gov.pt XLSX with streaming parse
- Swagger documentation at /docs

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Service health check |
| GET | /base/meta | Service metadata with sync stats (`last_sync`, `last_attempt`, `last_success`, `last_error`) |
| GET | /docs | Swagger UI |
| GET | /base/contracts | Paginated contract list (`page`, `limit`, `type`, `year`, `nif`) |
| GET | /base/contracts/search?q=termo | Text and/or NIF search; optional `from`, `to`, `year`; a 9-digit `q` is treated as NIF |
| GET | /base/contracts/lookup/:id | Live official API detail (APIBase2-V2), MongoDB fallback |

List and search responses include `source: "local" | "live"`. If the official API fails, the handler returns local results with `warning` and HTTP 200 — never 500.

`nif` must be exactly 9 digits. It matches both the contracting entity (adjudicante) and the awarded supplier (adjudicatário), using indexed `contractingNifs` / `awardedNifs` extracted from `"NIF - Nome"` labels and from V2 structured fields.

### Search bounds

Text search no longer uses MongoDB `$text` (the old text index was ~886 MiB and scanned 0.5–2.1 M keys per query). It runs a date-bounded case-insensitive match on `description`, `contractingEntity`, and `awarded`, using the existing `date` index:

- Default window: last **365** days (`SEARCH_WINDOW_DAYS`). Override with `from`/`to` (`YYYY-MM-DD`) or `year`.
- `limit` is capped at 100 (default 25); `page` stays 1-based.
- Every find/count has `maxTimeMS` (`SEARCH_MAX_TIME_MS`, default 5s). On timeout the handler returns HTTP 200 with `warning` and empty `data` — it does not keep the query running.
- NIF-only search is **not** date-windowed (it uses the NIF indexes).
- Unfiltered list/meta counts use `estimatedDocumentCount()` (collection metadata) instead of a 2.2 M-doc COLLSCAN.

## Setup

```
npm install
cp .env.example .env
```

Set `BASE_API_KEY` in `.env` if you have IMPIC API access (never commit the key).

```
npm start
npm test
```

Tests use in-memory fakes and never connect to MongoDB. Do not point `MONGO_URI` at production when running `npm test` or `npm run dev`.

## Environment

- `PORT`: 3003
- `MONGO_URI`: mongodb://localhost:27017/apiaberta-base
- `BASE_API_KEY`: Official IMPIC API key, read only from process.env / .env. Leave empty to disable official API enrichment, live NIF fallback, and V2 incremental sync. XLSX sync still runs.
- `SEARCH_WINDOW_DAYS`: default text-search window in days (default 365)
- `QUERY_MAX_TIME_MS`: Mongo `maxTimeMS` for list/count (default 5000)
- `SEARCH_MAX_TIME_MS`: Mongo `maxTimeMS` for text search (default 5000)
- `UPSERT_BATCH_SIZE`: `bulkWrite` batch size for V2 upserts (default 200)
- `V2_FETCH_MAX_DAYS`: max `numDias` for one V2 GetInfoContrato call (default 7, API hard max 90). Larger gaps overlay those recent days from V2 and fill the rest from streamed XLSX.

## Data Source

Bulk / catch-up sync uses public dados.gov.pt XLSX files (recommended by IMPIC for initial load). Files are downloaded to disk and parsed **row-by-row** (ExcelJS stream) so an ~80 MB yearly sheet cannot block the event loop or clone the whole workbook into RAM. Download size cap is 250 MB; exceeding it, a missing current-year file, or a parse failure is recorded as a **sync error** (`last_error`) — never as `synced: 0` success.

Official live enrichment and incremental updates use **APIBase2-V2**:

- Docs: https://www.base.gov.pt/APIBase2V2
- Auth header: `_AcessToken` (official typo, unchanged)
- Previous path `/APIBase2` is discontinued on **2026-12-04**

### What V2 allows

| Capability | Supported? |
|------------|------------|
| Contract by `idContrato` | Yes (`GetInfoContrato`) |
| Contracts by entity NIF (`nifEntidade`) | Yes (adjudicante or adjudicatário) |
| Last N days (`numDias`, max 90) | Yes — this connector requests at most `V2_FETCH_MAX_DAYS` (default 7) per call so a 90-day dump cannot load ~80 k docs into Node at once |
| Whole calendar year (`Ano`) | Yes (full-year dump; used only as a query param, not for bulk ingest) |
| Free-text search | **No** |
| Pagination | **No** |

To get API access:
1. Go to https://www.impic.pt/support/open.php
2. Select topic: Contratos Publicos / Pedido de acesso a API Portal Base
3. Wait for approval

Set `BASE_API_KEY` in `.env` to enable live official-API lookup, NIF fallback, and daily V2 incremental sync.
Without it those paths stay off (no error); bulk sync still uses public dados.gov.pt XLSX files.

www.base.gov.pt serves an incomplete TLS chain. The client adds the bundled intermediate in `certs/base-gov-intermediate.pem` to the system roots (verification stays on). Check a live call with `npm run check:base` (requires `BASE_API_KEY`).

`GET /base/contracts/lookup/:id` keeps the previous public strings (`contractingEntity`, `awarded`, `cpv` as `"NIF - Nome"` / `"code - description"`) and adds structured V2 fields (`contractingEntities`, `awardedEntities`, `cpvs`, lots, invited entities, contract status, estimated procedure price, occurrences).

## Sync

Daily at 03:00 Europe/Lisbon:

1. Residual NIF backfill if any docs still lack `nifsBackfilled` (skipped when `sync_state.nif_backfill_at` is set and a `limit(1)` check is empty). Guarded by an in-process lock so it cannot run twice in the same process. **Not started at process boot.**
2. **V2 incremental** (if `BASE_API_KEY` is set): `GetInfoContrato?numDias=N` where N is days since `last_success` plus one day of overlap, capped at `V2_FETCH_MAX_DAYS` (default 7). Upserts run in `bulkWrite` batches of 200. V2 cannot list by an arbitrary date interval, so a gap older than that cap is filled from XLSX (V2 still overlays the most recent N days).
3. **XLSX catch-up** when there is no API key, V2 failed, or `last_success` is more than `V2_FETCH_MAX_DAYS` ago. Initial load uses XLSX backfill (current year + one missing historical year per run). Year presence is a `findOne` on the `date` index, not a `countDocuments` COLLSCAN.

Startup only runs an XLSX backfill if the collection is empty (`estimatedDocumentCount() === 0`), or an incremental catch-up if `last_success` is older than 48h. A process-wide sync lock prevents overlap with the 03:00 cron.

`/base/meta` `stats`:

- `last_sync` / `last_success` — last fully successful run
- `last_attempt` — last run start
- `last_error` — last failure message (size-cap skip, download/parse error, V2 error); `null` after a clean run
- `contracts` — `estimatedDocumentCount()` (metadata; not an exact COLLSCAN)

## Indexes

Mongoose still ensures the small indexes (`id`, `date`, `value`, `synced_at`, `contractingNifs`, `awardedNifs`, `nifsBackfilled`). It does **not** create a text index.

On startup (after listen, in `setImmediate`) the process drops `description_text_contractingEntity_text_awarded_text` if it is still present:

| Action | Blocking? | Disk / memory |
|--------|-----------|----------------|
| `dropIndex` of the contracts text index | No document scan; metadata + file unlink | Frees **~886 MiB** of index data (measured 2026-11-12 on production: 885.9 MiB of 1146 MiB total indexes). WiredTiger cache and the OS page cache no longer keep that index resident during `$text` scans. |
| Replacement index | **None created.** Building a new text index on 2.2 M docs on a 3.7 GiB box would be the opposite of this change. | — |

The drop is idempotent (`IndexNotFound` / already absent is a no-op). No other index is created or dropped.

## License

MIT
