# ASTRABI Analytics — Application Documentation

> **⚠️ This document is partially out of date.**
> For the current architecture and how each engine works, see
> **[ARCHITECTURE.md](./ARCHITECTURE.md)** — that is the source of truth.
> This file is kept for the background detail it still covers accurately.

## Part 2: Features & Services

---

## 6. Data Ingestion Pipeline

### 6.1 CSV/Excel Upload

**Component**: [UploadView.tsx](components/UploadView.tsx)

- Drag-and-drop or file picker for `.csv`, `.xlsx`, `.xls`
- Excel parsing via `xlsx` library
- Auto-detects delimiter, encoding, and header row
- Displays preview before processing

### 6.2 Live Database Connections

**Component**: [ConnectorsPanel.tsx](components/ConnectorsPanel.tsx)

Supports two database engines:

| Database | Driver | Features |
|----------|--------|----------|
| **PostgreSQL** | `pg` | SSL, schema browsing, table selection |
| **SQL Server** | `mssql` | Windows auth, multi-table joins |

**Flow**: Connect → Browse schemas → Select tables → Auto-join detection → Column mapping → Import or Live mode

### 6.3 Connection Modes

| Mode | Description | Data Location |
|------|-------------|---------------|
| **Import** | Snapshot of data loaded into browser memory + DuckDB | Client-side |
| **Live** | Queries proxied to backend → real database | Server-side |

---

## 7. ETL Pipeline

**Service**: [etlPipeline.ts](services/etlPipeline.ts) (65KB)
**Worker**: [etl.worker.ts](workers/etl.worker.ts)
**UI**: [ETLView.tsx](components/ETLView.tsx)

Runs in a Web Worker to avoid blocking the UI. Steps:

| Step | Action | Example |
|------|--------|---------|
| 1 | **Type Detection** | Detect numeric, date, boolean, string columns |
| 2 | **Null Handling** | Replace nulls with defaults or remove rows |
| 3 | **Duplicate Removal** | Identify and remove exact duplicate rows |
| 4 | **Date Parsing** | Normalize date formats to ISO 8601 |
| 5 | **Numeric Cleaning** | Strip currency symbols, commas, percentages |
| 6 | **Column Renaming** | Standardize names (snake_case) |
| 7 | **Outlier Detection** | Flag statistical outliers (optional) |
| 8 | **Dim Date Generation** | Create date dimension table for time intelligence |

Every step produces an `ETLLog` entry with before/after row counts and sample transformations.

---

## 8. AI Semantic Profiling

**Service**: [aiSemanticProfiler.ts](services/aiSemanticProfiler.ts) (24KB)

After ETL, AI analyzes column metadata (names, types, samples) to produce a `DatasetDomainProfile`:

```typescript
interface DatasetDomainProfile {
  domain: string;         // "Sales", "HR", "Healthcare"
  subDomain?: string;     // "E-Commerce", "Payroll"
  summary: string;        // Natural language description
  confidence: number;     // 0-1 confidence score
  grain?: string;         // "Order", "Employee", "Patient"
  columnSemantics: Record<string, ColumnSemantic>;
}
```

**Privacy**: Only column names, types, and 3-5 sample values are sent to AI. Raw data never leaves the browser.

Each column receives a `ColumnSemantic`:

```typescript
interface ColumnSemantic {
  role: ColumnType;           // DIMENSION, METRIC, DATE, ID
  aggregation: AggregationType; // SUM, AVG, COUNT, etc.
  format: string;             // "currency_usd", "percent", "raw"
  humanLabel: string;         // "Unit Price", "Order Date"
  description: string;        // Business meaning
  semanticRole?: string;      // "primary_metric", "primary_date"
  isHidden: boolean;          // Auto-hide junk columns
}
```

---

## 9. Semantic Model

**Service**: [semanticModel.ts](services/semanticModel.ts) (23KB)

The deterministic semantic model is the **single source of truth** for all analysis features. It converts the AI profile into structured metadata:

- **Dimensions**: Columns you can group by (region, product, category)
- **Measures**: Columns you can aggregate (SUM, AVG, COUNT)
- **Date Columns**: Columns for time-series analysis with grain support
- **Metric Behaviors**: Additive, semi-additive, non-additive classification

Every feature reads from this model: Question Builder, AI SQL, Dashboard, Alerts, NLQ.

---

## 10. Question Builder

**Components**: [QuestionBuilder.tsx](components/QuestionBuilder.tsx) (70KB), [BuilderView.tsx](components/BuilderView.tsx) (63KB)

Point-and-click analytics tool:

| Setting | Options |
|---------|---------|
| **Measure** | Any METRIC column + aggregation (SUM, AVG, COUNT, etc.) |
| **Dimension** | Any DIMENSION column for grouping |
| **Date Column** | Time axis with grain (Year, Quarter, Month, Week, Day) |
| **Filters** | Column-level filters with operators (=, ≠, >, <, contains, etc.) |
| **Sort** | Ascending/descending by any column |
| **Limit** | Top N results |
| **Comparison** | Period-over-period (vs last month, vs last year) |

Produces a **QueryPlan** that is compiled to SQL and executed via DuckDB-WASM.

---

## 11. Query Plan Engine

**Service**: [queryPlan/](services/queryPlan/)

Deterministic SQL generation pipeline:

```
User Selection → buildQueryPlan() → validatePlan() → sqlCompiler() → DuckDB Execution
```

| Module | Purpose |
|--------|---------|
| `buildQueryPlan.ts` | Converts UI selections into a structured QueryPlan |
| `validatePlan.ts` | Validates plan consistency (no duplicate dimensions, valid aggregations) |
| `sqlCompiler.ts` | Compiles QueryPlan into DuckDB-compatible SQL |
| `executeQueryPlan.ts` | Executes SQL and returns typed results |
| `types.ts` | QueryPlan, QueryStep, Filter type definitions |

---

## 12. Natural Language Queries (NLQ)

**Service**: [nlqParser.ts](services/nlqParser.ts) (70KB)
**Component**: [NLQView.tsx](components/NLQView.tsx) (62KB)

Parses English questions into QueryPlans **without AI calls** using a deterministic NLP engine:

| Step | Example |
|------|---------|
| Tokenize | "total sales by region last quarter" → tokens |
| Intent Detection | Aggregation intent detected |
| Column Resolution | "sales" → `unit_price × quantity`, "region" → `region` column |
| Time Resolution | "last quarter" → date filter for Q-1 |
| Aggregation | "total" → SUM |
| Build Plan | QueryPlan with SUM(sales) GROUP BY region WHERE date IN Q-1 |

**Dictionary**: [nlqDictionary.ts](services/nlqDictionary.ts) — Synonym mappings for common business terms.

---

## 13. AI SQL Chat

**Service**: [ai-sql/pipeline.ts](services/ai-sql/pipeline.ts) (46KB)
**Component**: [AISQLChat.tsx](components/AISQLChat.tsx) (19KB)

Generates SQL from a natural-language question. Each question is standalone — no conversation history is kept or sent:

```
User Question → Intent Classification → Semantic Context → SQL Generation → Validation → Execution → Chart Recommendation → Explanation
```

### Sub-modules

| Module | Purpose |
|--------|---------|
| `intentPlanner.ts` | Classifies question type (aggregation, trend, comparison, ranking) |
| `semanticLayer.ts` | Builds column context for the AI prompt |
| `sqlGenerator.ts` | Generates SQL via Gemini/OpenRouter |
| `sqlValidator.ts` | Validates generated SQL syntax |
| `sqlCorrectionEngine.ts` | Auto-fixes invalid SQL (37KB of correction logic) |
| `chartRecommender.ts` | Selects optimal chart type for the result |
| `confidenceScorer.ts` | Scores result confidence |
| `resultProfiler.ts` | Analyzes result shape for explanation |
| `constraintGates.ts` | Prevents dangerous queries (DROP, DELETE, etc.) |
| `auditLogger.ts` | Logs all AI interactions |

---

## 14. Analysis Engine

**Service**: [analysisEngine.ts](services/analysisEngine.ts) (88KB)

Core computation engine that powers all analysis features:

- **Aggregation**: SUM, AVG, COUNT, COUNT_DISTINCT, MIN, MAX
- **Grouping**: Multi-dimensional GROUP BY
- **Filtering**: Column-level and global filters
- **Sorting**: Multi-column sort
- **Time Series**: Date-based aggregation with grain support
- **Comparisons**: Period-over-period calculations
- **Top N**: Ranking with configurable limits
- **Auto-Join**: Multi-table join resolution

---

## 15. DuckDB-WASM Engine

**Service**: [duckdbEngine.ts](services/duckdbEngine.ts) (21KB)

In-browser SQL database for local dataset analysis:

- Loads dataset rows into DuckDB tables
- Executes compiled SQL from QueryPlan engine
- Supports full SQL (JOINs, CTEs, window functions)
- Zero network latency — all computation in browser
- Used for import-mode datasets only

---

## 16. Chart Visualization

**Component**: [ChartVisualization.tsx](components/ChartVisualization.tsx) (94KB)

Supports 12+ chart types via Chart.js:

| Chart Type | Use Case |
|-----------|----------|
| Bar (vertical/horizontal) | Categorical comparisons |
| Line | Time series trends |
| Pie / Doughnut | Part-of-whole |
| Scatter | Correlation analysis |
| Stacked Bar | Composition over categories |
| Area | Volume trends |
| Treemap | Hierarchical data |
| Geo Map | Geographic distribution |
| KPI Card | Single-value metrics |
| Table | Raw data view |
| Small Multiples | Faceted comparisons |

Chart type is either user-selected or AI-recommended based on data shape.

---

## 17. Dashboard

**Component**: [Dashboard.tsx](components/Dashboard.tsx) (76KB)

Interactive dashboard with:

- **Drag-and-drop** grid layout (react-grid-layout)
- **Resizable** cards with responsive breakpoints
- **Pin** visuals from Question Builder or AI SQL
- **Global Filters** that apply across all pinned visuals
- **Date Filters** with hierarchical year → quarter → month selection
- **Export** as PNG screenshot (html2canvas)
- **Persistence** via IndexedDB

---

## 18. Metric Dictionary

**Service**: [metricTemplates/](services/metricTemplates/)
**Component**: [DerivedColumnsView.tsx](components/DerivedColumnsView.tsx)

300 curated business metric templates across 6 industries:

| Industry | Templates | Example Metrics |
|----------|-----------|-----------------|
| 💰 Sales | 50 | Total Sales, Profit Margin %, ROAS, Commission Earned |
| 👥 HR | 50 | Cost Per Hire, Turnover Rate %, Compa-Ratio, Absenteeism |
| 🏥 Healthcare | 50 | Bed Occupancy %, Readmission Rate, Cost Per Patient |
| 🏭 Manufacturing | 50 | OEE %, Yield Rate, MTBF, Scrap Cost |
| 📣 Marketing | 50 | CPC, ROAS, CAC, Email Open Rate %, Lead Conversion |
| 🎓 Education | 50 | Pass Rate %, Cost/Student, Student:Faculty Ratio |

**Features**:
- Auto-detects dataset domain and shows relevant industry first
- Column mapping with auto-suggest
- Live preview before creation
- Validation (rejects ID columns, divide-by-zero)
- Custom formula builder for unlisted metrics
- Derived columns register in semantic model for full system integration

---

## 19. Smart Questions

**Service**: [questionGenerator.ts](services/questionGenerator.ts), [domainQuestions.ts](services/domainQuestions.ts) (86KB)
**Component**: [SmartQuestionsView.tsx](components/SmartQuestionsView.tsx)

AI generates contextual analysis suggestions based on dataset structure:

- Domain-specific questions (Sales: "Top 10 products by revenue")
- Time-based questions ("Monthly sales trend")
- Comparison questions ("Revenue by region vs last year")
- One-click execution — click a suggestion to run instantly

---

## 20. Alerts & Monitoring

**Service**: [alertEngine.ts](services/alertEngine.ts) (14KB)
**Components**: [AlertsView.tsx](components/AlertsView.tsx), [AlertRuleWizard.tsx](components/AlertRuleWizard.tsx)

Business rule monitoring system:

| Alert Type | Example |
|-----------|---------|
| **Threshold** | "Alert when total sales drops below $10,000" |
| **Trend** | "Alert when profit margin decreases 20% vs last period" |

Alerts evaluate using the same QueryPlan pipeline as the Question Builder, ensuring semantic consistency.

---

## 21. Data Privacy & Security

### Column-Level Privacy

**Service**: [dataMasker.ts](services/dataMasker.ts) (12KB)

- Auto-detects PII patterns (email, phone, SSN, credit card)
- Applies reversible masking or irreversible anonymization
- Masking profiles configurable per dataset

### AI Data Privacy

- **Only metadata sent to AI**: Column names, types, semantic roles, 3-5 sample values
- **No raw data rows** are ever transmitted to AI services
- All computation happens locally in the browser (DuckDB-WASM)

### Authentication

- JWT-based session management
- bcrypt password hashing
- PostgreSQL user store (Railway-hosted)
- Session credential caching with auto-clear on logout

---

## 22. SQL Workbench

**Component**: [Workbench.tsx](components/Workbench.tsx) (115KB)

Advanced SQL editor for power users:

- Syntax-highlighted SQL editor
- Execute against DuckDB-WASM or live database
- Results table with sorting and export
- Query history
- Auto-complete for table/column names

---

## 23. Backend API

**Server**: [backend/server.js](backend/server.js) (49KB)

### Key Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/login` | POST | User authentication |
| `/api/auth/register` | POST | User registration |
| `/api/connect` | POST | Database connection |
| `/api/query` | POST | Execute SQL on live DB |
| `/api/schema` | GET | Browse database schema |
| `/api/tables` | GET | List available tables |
| `/api/ai/profile-dataset` | POST | AI semantic profiling |
| `/api/health` | GET | Health check |

---

## 24. State Management

**Store**: Zustand-based stores in `store/` directory

Key state:
- Active dataset
- Dashboard layout and pinned visuals
- User authentication
- Theme (dark/light)
- Sidebar navigation state
- Alert configurations

Persistence via IndexedDB ([datasetDB.ts](services/datasetDB.ts), [indexedDBStorage.ts](services/indexedDBStorage.ts))

---

## 25. Build & Deployment

### Development
```bash
npm run dev          # Start Vite dev server
```

### Production Build
```bash
npm run build        # Build to dist/
npm run preview      # Preview production build locally
```

### Testing
```bash
npm run test         # Run vitest unit tests
```

### Deployment Pipeline
1. Push to `main` branch on GitHub
2. Vercel auto-deploys frontend
3. Railway auto-deploys backend
4. Production URL: `https://quickinsight.co.uk`
