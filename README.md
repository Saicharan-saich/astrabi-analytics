<div align="center">

# QuickInsight

### Self-Service Exploratory Data Analytics & Business Intelligence

[![Built with React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## What is QuickInsight?

QuickInsight is a **self-service exploratory data analytics (EDA) tool** that lets anyone — analysts, managers, or non-technical users — upload a dataset and instantly explore it through interactive charts, dashboards, and a guided question builder. No SQL, no code, no setup.

Upload a CSV, and QuickInsight's **semantic inference engine** automatically classifies every column (metric, dimension, date, ID), cleans and normalizes your data through a 7-layer ETL pipeline, and presents a curated set of analytics questions you can answer with one click.

---

## Core Capabilities

| Capability | Description |
|---|---|
| **Semantic Column Inference** | Automatically classifies columns as metrics, dimensions, dates, or IDs based on statistical profiling — no manual mapping required. |
| **7-Layer ETL Pipeline** | Client-side data cleaning: structural repair, null handling, type coercion, date normalization, and data quality scoring — all before a single chart is drawn. |
| **Mad-Lib Question Builder** | Guided query construction: _"Show me **[metric]** (Sum) by **[dimension]** for **[time period]**"_. Eliminates the need to write SQL or understand data schemas. |
| **Smart Visualizations** | Automatically selects the best chart type (bar, line, area, doughnut, treemap, combo, KPI card) based on data shape, cardinality, and query structure. |
| **Pinnable Dashboards** | Pin any analysis to a persistent, drag-and-drop dashboard with auto-saving layout. |
| **Authentication** | Built-in JWT authentication with secure session management. |

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+

### 1. Clone

```bash
git clone https://github.com/Saicharan-saich/QuickInsight-analytics.git
cd QuickInsight-analytics
```

### 2. Install

```bash
# Frontend
npm install

# Backend
cd backend
npm install
cd ..
```

### 3. Run

```bash
# Terminal 1 — Backend API (port 5002)
cd backend
node server.js

# Terminal 2 — Frontend (port 3000)
npm run dev
```

Open **http://localhost:3000** in your browser.

### 4. First Use

1. **Register** an account on the sign-in page
2. **Upload a CSV** or click **Try Sample Data**
3. The ETL pipeline automatically cleans and profiles your data
4. Navigate to **Workbench** and explore using the Question Builder or pre-built questions

---

## How It Works

```
CSV Upload
    │
    ▼
┌──────────────────────────────┐
│  7-Layer ETL Pipeline        │
│  ┌─────────────────────────┐ │
│  │ L1  Structural Repair   │ │
│  │ L2  Null Canonicalization│ │
│  │ L3  Column Profiling    │ │
│  │ L4  Semantic Inference  │ │
│  │ L5  Type Coercion       │ │
│  │ L6  Contract Validation │ │
│  │ L7  DimDate Generation  │ │
│  └─────────────────────────┘ │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Semantic Column Map         │
│  metric ← revenue, qty...   │
│  dimension ← region, dept...│
│  date ← order_date...       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Question Builder            │
│  "Show me [metric] by [dim]" │
│  + time filters, sorts,      │
│    aggregations, comparisons │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Deterministic SQL Engine    │
│  → Chart Rendering           │
│  → Pin to Dashboard          │
└──────────────────────────────┘
```

---

## Project Structure

```
QuickInsight-analytics/
├── App.tsx                     # Application entry point
├── types.ts                    # TypeScript interfaces
├── components/
│   ├── Workbench.tsx           # Main analysis workspace
│   ├── QuestionBuilder.tsx     # Guided query builder
│   ├── ChartVisualization.tsx  # Chart rendering (Chart.js)
│   ├── Dashboard.tsx           # Pinnable dashboard
│   └── ...
├── services/
│   ├── analysisEngine.ts       # Core analytics engine
│   ├── evaluateLocally.ts      # Client-side query execution
│   ├── etlPipeline.ts          # 7-layer ETL pipeline
│   ├── questionRegistry.ts     # Question bank
│   └── ...
├── backend/
│   └── server.js               # Express API (auth, connectors)
├── workers/
│   └── etl.worker.ts           # Web Worker for ETL
└── store/                      # Zustand state management
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, TypeScript, Vite |
| **State** | Zustand |
| **Charts** | Chart.js, react-chartjs-2 |
| **Styling** | Tailwind CSS |
| **Animations** | Framer Motion |
| **Backend** | Node.js, Express |
| **Storage** | IndexedDB (client), file-based (server) |

---

## Scripts

```bash
npm run dev       # Start development server
npm run build     # Production build
npm run preview   # Preview production build
npm run test      # Run tests
```

---

## License

MIT © [Saicharan](https://github.com/Saicharan-saich)
