# connector-base

BASE.gov.pt public contracts connector for API Aberta.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| GET | `/contracts` | Recent contracts (paginated) |
| GET | `/contracts/search?q=termo` | Full-text search |

## Query Parameters

### GET /contracts
- `page` — page number (default: 1)
- `limit` — results per page (default: 25, max: 100)
- `type` — filter by type (`ajuste`, `concurso`)

### GET /contracts/search
- `q` — search term (required)
- `page`, `limit` — pagination

## Data Source

- `https://www.base.gov.pt/Base4/pt/resultado/`
- Syncs daily at 03:00 (Lisbon time)

## Setup

```bash
npm install
pm2 start ecosystem.config.js
```

## Via API Aberta Gateway

```
GET https://api.apiaberta.pt/v1/base/contracts
GET https://api.apiaberta.pt/v1/base/contracts/search?q=câmara
```
