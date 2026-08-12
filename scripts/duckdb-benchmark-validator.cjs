#!/usr/bin/env node
'use strict';

const path = require('path');
const readline = require('readline');
const duckdb = require('../node_modules/@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');

const quoteIdentifier = value => `"${String(value).replace(/"/g, '""')}"`;
const safeTableName = value => String(value).replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'dataset';

function columnType(rows, column) {
  let hasDate = false;
  let hasNumber = false;
  for (const row of rows) {
    const value = row[column];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'number') { hasNumber = true; continue; }
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text)) { hasDate = true; continue; }
    const numeric = Number(text.replace(/[$,]/g, ''));
    if (Number.isFinite(numeric)) { hasNumber = true; continue; }
    return 'VARCHAR';
  }
  return !hasDate && hasNumber ? 'DOUBLE' : 'VARCHAR';
}

function sqlValue(value, type) {
  if (value === null || value === undefined) return 'NULL';
  const text = String(value);
  if (type === 'DOUBLE') {
    const numeric = Number(text.replace(/[$,]/g, ''));
    return Number.isFinite(numeric) ? String(numeric) : 'NULL';
  }
  return `'${text.replace(/'/g, "''")}'`;
}

function normalizeDateExpressions(sql) {
  return sql.replace(
    /(?:DATETIME|DATE)\s*\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?\s*\)/gi,
    (match, dateText, modifier) => {
      if (!modifier) return `'${dateText}'`;
      const parsed = modifier.match(/^([+-]?\d+)\s+(day|days|month|months|year|years)$/i);
      if (!parsed) return match;
      const amount = Number(parsed[1]);
      const unit = parsed[2].toUpperCase().replace(/S$/, '');
      const operator = amount >= 0 ? '+' : '-';
      if (dateText.toLowerCase() === 'now') return `(CURRENT_DATE ${operator} INTERVAL ${Math.abs(amount)} ${unit})`;
      return `(DATE '${dateText}' ${operator} INTERVAL ${Math.abs(amount)} ${unit})`;
    },
  );
}

function normalizeSQL(sql) {
  let normalized = sql;
  normalized = normalized.replace(/FROM\s+["']?orders["']?/gi, 'FROM data');
  normalized = normalized.replace(/FROM\s+["']?data["']?/gi, 'FROM data');
  normalized = normalized.replace(/\[(\w+)\]/g, '"$1"');
  normalized = normalized.replace(/`([^`]+)`/g, (_match, identifier) => quoteIdentifier(identifier));
  normalized = normalized.replace(/\bSTRFTIME\b/gi, 'strftime');
  normalized = normalized.replace(/\bSUBSTR\s*\(/gi, 'SUBSTRING(');
  normalized = normalized.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  return normalizeDateExpressions(normalized);
}

function epochToDateString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  let milliseconds;
  if (value instanceof Date) milliseconds = value.getTime();
  else {
    const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
    if (!Number.isFinite(numeric)) return null;
    milliseconds = Math.abs(numeric) < 1e6 ? numeric * 86400000 : numeric;
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

function scalar(value, isDate) {
  if (isDate) return epochToDateString(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

async function main() {
  const dist = path.resolve(__dirname, '../node_modules/@duckdb/duckdb-wasm/dist');
  const bundles = {
    mvp: {
      mainModule: path.join(dist, 'duckdb-mvp.wasm'),
      mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs'),
    },
  };
  const database = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await database.instantiate();
  database.open({ query: { castBigIntToDouble: true } });
  const connection = database.connect();
  let createdTables = [];

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      for (const table of createdTables) connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
      createdTables = [];
      const request = JSON.parse(line);
      const asset = request.asset;
      const tables = [
        { name: 'data', rows: asset.rows },
        ...(asset.relatedTables || []).filter(table => safeTableName(table.name) !== 'data'),
      ];
      for (const table of tables) {
        const name = safeTableName(table.name);
        const rows = table.rows || [];
        if (!rows.length || createdTables.includes(name)) continue;
        const columns = Object.keys(rows[0]);
        const types = Object.fromEntries(columns.map(column => [column, columnType(rows, column)]));
        const definitions = columns.map(column => `${quoteIdentifier(column)} ${types[column]}`).join(', ');
        connection.query(`CREATE TABLE ${quoteIdentifier(name)} (${definitions})`);
        createdTables.push(name);
        for (let start = 0; start < rows.length; start += 500) {
          const values = rows.slice(start, start + 500).map(row => `(${columns.map(column => sqlValue(row[column], types[column])).join(',')})`).join(',');
          connection.query(`INSERT INTO ${quoteIdentifier(name)} VALUES ${values}`);
        }
      }

      const result = connection.query(normalizeSQL(request.sql));
      if (result.numRows > Number(request.maxRows || 200)) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: 'result_too_large' })}\n`);
        continue;
      }
      const fields = result.schema.fields;
      const names = fields.map(field => field.name);
      if (!names.length || new Set(names.map(name => name.toLowerCase())).size !== names.length) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: 'duplicate_columns' })}\n`);
        continue;
      }
      const dateColumns = new Set(fields.filter(field => /date|timestamp/i.test(String(field.type))).map(field => field.name));
      const rows = [];
      for (let index = 0; index < result.numRows; index += 1) {
        const row = {};
        for (const name of names) row[name] = scalar(result.getChild(name)?.get(index) ?? null, dateColumns.has(name));
        rows.push(row);
      }
      process.stdout.write(`${JSON.stringify({ ok: true, rows })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  connection.close();
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
