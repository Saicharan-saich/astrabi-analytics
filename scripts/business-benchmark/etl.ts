import { readFileSync, writeFileSync } from 'fs';
import { runETLPipeline } from '/home/claude/astrabi-analytics/services/etlPipeline';
const dir = '/tmp/claude-0/-home-claude/e0b07139-5555-5210-9130-52450b6c1df6/scratchpad/bench/';
for (const [key, file] of [['retail', 'retail_orders.csv'], ['weekly', 'weekly_store_sales.csv'], ['appointments', 'appointments.csv'], ['employees', 'employees.csv']]) {
  const raw = JSON.parse(readFileSync(`${dir}raw_${key}.json`, 'utf8'));
  const r = runETLPipeline(raw, file);
  const ds = { id: `business-${key}`, name: file, rows: r.rows, columns: r.columns, totalRows: r.rows.length, timeContext: r.timeContext };
  writeFileSync(`${dir}ds_${key}.json`, JSON.stringify(ds));
  console.log(`== ${key}: ${raw.length} → ${r.rows.length} rows`);
  console.log(r.columns.map((c: any) => `${c.name}:${c.type}`).join('  '));
  console.log(JSON.stringify(r.rows[0]));
  console.log((r.logs || []).filter((l: any) => l.status === 'applied').map((l: any) => `${l.step}: ${String(l.details).slice(0, 90)}`).join('\n'));
}
