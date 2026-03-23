# API Aberta — Public Contracts Connector (BASE)

Microservice for public procurement data from BASE.gov.pt.

## Features

- Search public contracts
- Contract details
- Entity information
- Statistical summaries

## Endpoints

- `GET /health` — Service health check
- `GET /meta` — Service metadata
- `GET /contracts` — Search contracts
- `GET /contracts/:id` — Contract details
- `GET /entities` — Public entities

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## Data Source

BASE.gov.pt open data.

## License

MIT
