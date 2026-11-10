import { readFileSync, writeFileSync } from 'fs';
import { parseDelimitedText } from '../../services/delimitedText';
import { runETLPipeline } from '../../services/etlPipeline';
// The folder holding the CSVs from gen_raw.py; writes ds_<key>.json beside them. The files go
// through the same parser and cleaner as an upload.
const dir = process.argv[2] || './';
for (const [key, file] of [['cafe', 'cafe_square_items.csv'], ['shop', 'shop_till_export.csv'], ['online', 'shopify_orders.csv']]) {
  const parsed = parseDelimitedText(readFileSync(`${dir}${file}`, 'utf8'));
  const r = runETLPipeline(parsed.rows, file);
  const ds = { id: `owner-${key}`, name: file, rows: r.rows, columns: r.columns, totalRows: r.rows.length, timeContext: r.timeContext };
  writeFileSync(`${dir}ds_${key}.json`, JSON.stringify(ds));
  console.log(`== ${key}: ${parsed.rows.length} → ${r.rows.length} rows`);
  console.log(r.columns.map((c: any) => `${c.name}:${c.type}`).join('  '));
  console.log(JSON.stringify(r.rows[0]));
  console.log(JSON.stringify(r.rows[1]));
  console.log(((r as any).logs || []).filter((l: any) => l.status === 'applied').map((l: any) => `${l.step}: ${String(l.details).slice(0, 110)}`).join('\n'));
}
