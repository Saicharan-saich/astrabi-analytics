import { readFileSync, writeFileSync } from 'fs';
import { runETLPipeline } from '../../services/etlPipeline';
// The folder holding raw_<name>.json from gen_raw.py; writes ds_<name>.json beside them.
const dir = process.argv[2] || './';
for (const [key, file] of [['retail', 'retail_orders.csv'], ['weekly', 'weekly_store_sales.csv'], ['appointments', 'appointments.csv'], ['employees', 'employees.csv']]) {
  const raw = JSON.parse(readFileSync(`${dir}raw_${key}.json`, 'utf8'));
  const r = runETLPipeline(raw, file);
  const ds = { id: `business-${key}`, name: file, rows: r.rows, columns: r.columns, totalRows: r.rows.length, timeContext: r.timeContext };
  writeFileSync(`${dir}ds_${key}.json`, JSON.stringify(ds));
  console.log(`== ${key}: ${raw.length} → ${r.rows.length} rows`);
  console.log(r.columns.map((c: any) => `${c.name}:${c.type}`).join('  '));
  console.log(JSON.stringify(r.rows[0]));
  console.log(((r as any).logs || []).filter((l: any) => l.status === 'applied').map((l: any) => `${l.step}: ${String(l.details).slice(0, 90)}`).join('\n'));
}
