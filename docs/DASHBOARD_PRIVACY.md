# Dashboard privacy and account isolation

Dashboard sync saves definitions: names, layout, chart formatting, dataset
references, SQL and filter settings. It does not sync result rows (even samples),
KPI values, growth values, generated insights, validation output, or chart images.
SQL, titles and chosen filters are settings and may contain user-supplied values.
They are not advertised as containing no business information.

The browser and API use the same recursive allowlist in
`shared/dashboardPrivacy.mjs`. Cached results never enter the outgoing retry
queue. The API also applies the allowlist to incoming and historical records.
On backend startup, existing dashboard payloads are scrubbed without deleting
the dashboard definitions. This does not remove historical database backups or
data previously processed by external services.

The dashboard UPSERT verifies ownership atomically. A conflicting ID owned by
another account returns HTTP 409. Client requests capture their original
session; pending requests and retries are cancelled when accounts change.

On the same device, an unchanged recipe keeps its complete local chart cache.
When local results are unavailable, a card displays a source-data prompt and
rebuilds automatically when its original local dataset is available. A user can
explicitly bind a reopened file using “Use current dataset”. Layout, filters,
formatting and AI SQL refresh recipes remain available. Rebuilding invokes the
local query engine, not an LLM.

Smart Insight remains a separate feature that sends a rendered chart image to
AI. Images can contain visible values or personal information. AI SQL's private
mode does not govern this image feature. PostgreSQL and SQL Server connectors
also pass credentials and query results through the backend.

Deploy the backend and frontend changes together. The backend removes legacy
stored results, while the new frontend prevents result rows from being sent.
An already-open older frontend must be reloaded to get that transport fix.
