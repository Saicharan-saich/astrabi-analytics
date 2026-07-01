# QuickInsight Backend API

Backend service for SQL Server connectivity.

## Setup

1. Install dependencies:
```bash
cd backend
npm install
```

2. Start the server:
```bash
npm start
```

The API will run on `http://localhost:3002`

## Endpoints

- `POST /api/connect` - Test SQL Server connection
- `POST /api/schema` - Get list of tables
- `POST /api/query` - Fetch table data
- `GET /api/health` - Health check
