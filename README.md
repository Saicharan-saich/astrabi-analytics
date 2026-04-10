<div align="center">

# Astrabi Analytics

**Deterministic Semantic Inference Analytics — Domain Agnostic, Zero-Config**

[![Built with React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## What is Astrabi?

Astrabi Analytics is a self-service BI platform that turns any CSV or database into interactive dashboards, charts, and insights — **without writing a single line of SQL**. Upload your data, and Astrabi automatically detects the domain (HR, Finance, Healthcare, Sales, etc.) through deterministic semantic inference, maps columns to canonical roles, and generates relevant analytics questions.

### Key Features

- **🧠 AI Domain Detection** — Automatically identifies your data domain (HR, Finance, Healthcare, Inventory, SaaS, Education, Marketing, Sales) and adapts the entire experience.
- **📊 82+ Pre-Built Questions** — Domain-specific question banks with 210+ questions across 7 industries, plus a universal builder for custom queries.
- **🔍 Natural Language Querying** — Ask questions in plain English. The AI SQL engine translates them into deterministic queries.
- **📈 Smart Visualizations** — Auto-selects the best chart type (bar, line, area, doughnut, treemap, combo, KPI cards) based on your data and question.
- **🧹 7-Layer ETL Pipeline** — Automatic data cleaning, type detection, null handling, date normalization, and quality scoring — all client-side.
- **📌 Pinnable Dashboards** — Pin any chart to a drag-and-drop dashboard with persistent layout.
- **🔗 Database Connectors** — Connect directly to SQL Server (Windows Auth + SQL Auth) and PostgreSQL.
- **🔒 Authentication** — Built-in JWT auth with file-based user persistence.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- An [OpenRouter API key](https://openrouter.ai/) (for AI domain detection — optional, app works without it)

### 1. Clone the repository

```bash
git clone https://github.com/Saicharan-saich/astrabi-analytics.git
cd astrabi-analytics
```

### 2. Install dependencies

```bash
# Frontend
npm install

# Backend
cd backend
npm install
cd ..
```

### 3. Configure environment

Create a `backend/.env` file:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
FRONTEND_URL=http://localhost:3000
```

> **Note:** The app works fully without the API key — AI domain detection will be skipped and the app falls back to heuristic column mapping.

### 4. Start the application

```bash
# Terminal 1 — Backend API (port 5002)
cd backend
node server.js

# Terminal 2 — Frontend (port 3000)
npm run dev
```

Open **http://localhost:3000** in your browser.

### 5. First use

1. **Register** a new account on the login page
2. **Upload a CSV** file or click "Try Sample Data"
3. The ETL pipeline automatically cleans and profiles your data
4. If an API key is configured, AI will detect the domain and suggest relevant questions
5. Navigate to **Workbench** to explore your data with pre-built questions or the custom builder

---

## Project Structure

```
astrabi-analytics/
├── App.tsx                    # Main application entry
├── types.ts                   # All TypeScript interfaces
├── components/
│   ├── Workbench.tsx          # Main analysis workspace
│   ├── QuestionBuilder.tsx    # Visual query builder
│   ├── QuestionCustomizer.tsx # Question refinement panel
│   ├── ChartVisualization.tsx # Chart rendering (Chart.js)
│   ├── Dashboard.tsx          # Pinned charts dashboard
│   ├── DomainReviewModal.tsx  # AI domain detection review
│   ├── AISQLChat.tsx          # Natural language SQL interface
│   └── ...
├── services/
│   ├── analysisEngine.ts      # Core analytics engine
│   ├── evaluateLocally.ts     # Client-side query execution
│   ├── etlPipeline.ts         # 7-layer ETL pipeline
│   ├── questionRegistry.ts    # Question bank management
│   ├── domainQuestions.ts     # 210+ domain-specific questions
│   ├── aiSemanticProfiler.ts  # AI domain detection
│   ├── dataMasker.ts          # PII-safe data profiling
│   └── ai-sql/               # AI SQL pipeline modules
├── backend/
│   └── server.js              # Express API (auth, DB connectors, AI proxy)
├── workers/
│   └── etl.worker.ts          # Web Worker for ETL processing
└── store/                     # Zustand state management
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
| **Database** | SQL Server (mssql), PostgreSQL (pg) |
| **AI** | OpenRouter API (Gemini 2.0 Flash) |
| **Storage** | IndexedDB (client-side), file-based (server-side) |

---

## Supported Domains

Astrabi automatically detects and adapts to these industry domains:

| Domain | Example Questions |
|--------|------------------|
| **Sales** | Revenue vs yesterday, Top 5 products, Sales by channel |
| **HR** | Headcount by department, Attrition rate, Salary distribution |
| **Finance** | Revenue trend, Budget vs actual, Profit margin by segment |
| **Healthcare** | Patient volume, Length of stay, Readmission rate |
| **Inventory** | Stock levels, Turnover rate, Reorder alerts |
| **SaaS** | MRR growth, Churn rate, LTV:CAC ratio |
| **Education** | Enrollment trend, GPA distribution, Graduation rate |
| **Marketing** | Campaign ROI, Conversion funnel, CAC by channel |

---

## Scripts

```bash
npm run dev       # Start development server
npm run build     # Build for production
npm run preview   # Preview production build
npm run test      # Run tests
```

---

## License

MIT © [Saicharan](https://github.com/Saicharan-saich)
