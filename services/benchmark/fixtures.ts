import {
  ColumnType,
  type ColumnDefinition,
  type ColumnSemantic,
  type Dataset,
  type DatasetDomainProfile,
} from '../../types';
import type {
  BenchmarkCase,
  BenchmarkDifficulty,
  BenchmarkSuite,
  BenchmarkSuiteId,
} from './types';

type Row = Record<string, string | number | boolean | null>;
type Aggregate = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';
type FilterOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'between';

interface MetricSpec {
  field?: string;
  aggregate: Aggregate;
  alias: string;
}

interface FilterSpec {
  field: string;
  operator: FilterOperator;
  value: string | number | boolean | Array<string | number | boolean>;
}

interface HavingSpec {
  alias: string;
  operator: '>' | '>=' | '<' | '<=';
  value: number;
}

interface FixtureQuerySpec {
  question: string;
  category: string;
  difficulty: BenchmarkDifficulty;
  dimensions?: string[];
  metrics: MetricSpec[];
  filters?: FilterSpec[];
  having?: HavingSpec;
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  orderMatters?: boolean;
  tags?: string[];
}

interface SuiteFieldConfig {
  suiteId: BenchmarkSuiteId;
  entityLabel: string;
  primaryMetric: string;
  primaryMetricLabel: string;
  secondaryMetric: string;
  secondaryMetricLabel: string;
  quantityMetric: string;
  quantityLabel: string;
  durationMetric: string;
  durationLabel: string;
  scoreMetric: string;
  scoreLabel: string;
  dateField: string;
  primaryDimension: string;
  primaryDimensionLabel: string;
  secondaryDimension: string;
  secondaryDimensionLabel: string;
  tertiaryDimension: string;
  tertiaryDimensionLabel: string;
  segmentDimension: string;
  segmentDimensionLabel: string;
  statusField: string;
  statusValue: string;
  booleanField: string;
  distinctField: string;
  secondaryValue: string;
  tertiaryValue: string;
  segmentValue: string;
  startDate: string;
  midDate: string;
  endDate: string;
  primaryThreshold: number;
  secondaryThreshold: number;
  scoreThreshold: number;
  durationThreshold: number;
}

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: string | number | boolean): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${value.replace(/'/g, "''")}'`;
}

function compileFilter(filter: FilterSpec): string {
  const field = sqlIdentifier(filter.field);
  if (filter.operator === 'in') {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return `${field} IN (${values.map(value => sqlLiteral(value as string | number | boolean)).join(', ')})`;
  }
  if (filter.operator === 'between') {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value, filter.value];
    return `${field} BETWEEN ${sqlLiteral(values[0] as string | number | boolean)} AND ${sqlLiteral(values[1] as string | number | boolean)}`;
  }
  return `${field} ${filter.operator} ${sqlLiteral(filter.value as string | number | boolean)}`;
}

function compileMetric(metric: MetricSpec): string {
  const expression = metric.aggregate === 'count' && !metric.field
    ? 'COUNT(*)'
    : metric.aggregate === 'count_distinct'
      ? `COUNT(DISTINCT ${sqlIdentifier(metric.field || '')})`
      : `${metric.aggregate.toUpperCase()}(${sqlIdentifier(metric.field || '')})`;
  return `${expression} AS ${sqlIdentifier(metric.alias)}`;
}

function compileGoldSql(spec: FixtureQuerySpec): string {
  const dimensions = spec.dimensions || [];
  const select = [...dimensions.map(sqlIdentifier), ...spec.metrics.map(compileMetric)].join(',\n  ');
  const parts = [`SELECT\n  ${select}\nFROM "data"`];
  if (spec.filters?.length) parts.push(`WHERE ${spec.filters.map(compileFilter).join('\n  AND ')}`);
  if (dimensions.length) parts.push(`GROUP BY ${dimensions.map(sqlIdentifier).join(', ')}`);
  if (spec.having) {
    parts.push(`HAVING ${sqlIdentifier(spec.having.alias)} ${spec.having.operator} ${spec.having.value}`);
  }
  if (spec.orderBy?.length) {
    parts.push(`ORDER BY ${spec.orderBy.map(item => `${sqlIdentifier(item.field)} ${item.direction.toUpperCase()}`).join(', ')}`);
  }
  if (spec.limit) parts.push(`LIMIT ${spec.limit}`);
  return parts.join('\n');
}

function compareValues(left: unknown, operator: FilterOperator | HavingSpec['operator'], right: unknown): boolean {
  if (operator === 'in') return (right as unknown[]).some(value => String(value) === String(left));
  if (operator === 'between') {
    const [min, max] = right as unknown[];
    return String(left) >= String(min) && String(left) <= String(max);
  }
  if (operator === '=') return String(left) === String(right);
  if (operator === '!=') return String(left) !== String(right);
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === '>') return left > right;
    if (operator === '>=') return left >= right;
    if (operator === '<') return left < right;
    return left <= right;
  }
  const leftValue = String(left);
  const rightValue = String(right);
  if (operator === '>') return leftValue > rightValue;
  if (operator === '>=') return leftValue >= rightValue;
  if (operator === '<') return leftValue < rightValue;
  return leftValue <= rightValue;
}

function aggregate(rows: Row[], metric: MetricSpec): number {
  if (metric.aggregate === 'count' && !metric.field) return rows.length;
  const rawValues = rows
    .map(row => metric.field ? row[metric.field] : null)
    .filter(value => value !== null && value !== undefined);
  if (metric.aggregate === 'count') return rawValues.length;
  if (metric.aggregate === 'count_distinct') return new Set(rawValues.map(String)).size;
  const values = rawValues.map(Number).filter(Number.isFinite);
  if (!values.length) return 0;
  if (metric.aggregate === 'sum') return round(values.reduce((sum, value) => sum + value, 0));
  if (metric.aggregate === 'avg') return round(values.reduce((sum, value) => sum + value, 0) / values.length);
  if (metric.aggregate === 'min') return Math.min(...values);
  return Math.max(...values);
}

function materializeExpectedRows(rows: Row[], spec: FixtureQuerySpec): Record<string, unknown>[] {
  const filtered = rows.filter(row => (spec.filters || []).every(filter =>
    compareValues(row[filter.field], filter.operator, filter.value)
  ));
  const dimensions = spec.dimensions || [];
  const groups = new Map<string, Row[]>();

  for (const row of filtered) {
    const key = JSON.stringify(dimensions.map(dimension => row[dimension]));
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  if (!dimensions.length && !groups.size) groups.set('[]', []);

  let result = [...groups.entries()].map(([key, groupRows]) => {
    const dimensionValues = JSON.parse(key) as unknown[];
    const output: Record<string, unknown> = {};
    dimensions.forEach((dimension, index) => { output[dimension] = dimensionValues[index]; });
    spec.metrics.forEach(metric => { output[metric.alias] = aggregate(groupRows, metric); });
    return output;
  });

  if (spec.having) {
    result = result.filter(row => compareValues(row[spec.having!.alias], spec.having!.operator, spec.having!.value));
  }
  if (spec.orderBy?.length) {
    result.sort((left, right) => {
      for (const order of spec.orderBy || []) {
        const leftValue = left[order.field];
        const rightValue = right[order.field];
        const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
        if (comparison !== 0) return order.direction === 'asc' ? comparison : -comparison;
      }
      return 0;
    });
  }
  if (spec.limit) result = result.slice(0, spec.limit);
  return result;
}

function inferColumnType(name: string, value: Row[string]): ColumnType {
  if (name.endsWith('_date') || /^date_/.test(name)) return ColumnType.DATE;
  if (name.endsWith('_id') || name === 'invoice_number') return ColumnType.ID;
  if (typeof value === 'boolean') return ColumnType.BOOLEAN;
  if (typeof value === 'number') return ColumnType.METRIC;
  return ColumnType.DIMENSION;
}

function createDataset(
  id: string,
  name: string,
  rows: Row[],
  domain: string,
  grain: string,
  dateField: string,
  averageFields: string[],
): Dataset {
  const sample = rows[0];
  const columns: ColumnDefinition[] = Object.keys(sample).map(column => ({
    name: column,
    type: inferColumnType(column, sample[column]),
    originalType: typeof sample[column],
  }));
  const dates = rows.map(row => String(row[dateField])).sort();
  const columnSemantics = Object.fromEntries(columns.map(column => {
    const isAverage = averageFields.includes(column.name);
    const semantic: ColumnSemantic = {
      role: column.type,
      aggregation: column.type === ColumnType.METRIC ? (isAverage ? 'AVG' : 'SUM')
        : column.type === ColumnType.ID ? 'COUNT_DISTINCT' : 'NONE',
      format: column.type === ColumnType.DATE ? 'date_iso'
        : column.name.includes('rate') || column.name.includes('score') || column.name === 'discount' ? 'percent'
          : column.type === ColumnType.METRIC ? 'raw' : 'raw',
      humanLabel: column.name.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()),
      description: `Benchmark fixture field: ${column.name.replace(/_/g, ' ')}.`,
      semanticRole: column.name === dateField ? 'primary_date'
        : column.type === ColumnType.METRIC ? 'metric'
          : column.type === ColumnType.ID ? 'identifier' : 'dimension',
      isHidden: false,
    };
    return [column.name, semantic];
  })) as Record<string, ColumnSemantic>;

  const domainProfile: DatasetDomainProfile = {
    domain,
    subDomain: 'Benchmark fixture',
    summary: `Deterministic, synthetic ${domain.toLowerCase()} fixture for repeatable AI SQL evaluation.`,
    confidence: 1,
    grain,
    columnSemantics,
    suggestedQuestionCategories: ['KPI', 'Breakdown', 'Filter', 'Ranking', 'Time'],
    detectedAt: 0,
  };

  return {
    id,
    name,
    rows,
    rawRows: rows,
    columns,
    totalRows: rows.length,
    etlLogs: [],
    timeContext: {
      minDate: dates[0],
      maxDate: dates[dates.length - 1],
      defaultAnchorDate: dates[dates.length - 1],
      anchorDateColumn: dateField,
      dateColumnMaxDates: { [dateField]: dates[dates.length - 1] },
    },
    domainProfile,
    version: 1,
    createdAt: 0,
  };
}

function createRetailRows(): Row[] {
  const products = [
    ['Atlas Laptop', 'Technology'], ['Beacon Desk', 'Furniture'], ['Cedar Chair', 'Furniture'],
    ['Delta Printer', 'Technology'], ['Echo Binder', 'Office Supplies'], ['Flux Monitor', 'Technology'],
  ] as const;
  const regions = ['North', 'South', 'East', 'West'];
  const segments = ['Consumer', 'Corporate', 'Small Business'];
  const reps = ['Amina Shah', 'Ben Cole', 'Cara Liu', 'Diego Ruiz'];
  const shipModes = ['Standard', 'Express', 'Same Day'];
  const rows: Row[] = [];

  for (let index = 0; index < 72; index += 1) {
    const productIndex = index % products.length;
    const regionIndex = index % regions.length;
    const monthIndex = index % 24;
    const year = 2023 + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const discount = [0, 0.05, 0.1, 0.2, 0.3][index % 5];
    const returned = index % 11 === 0;
    const quantity = 1 + (index % 8);
    const gross = 140 + productIndex * 95 + regionIndex * 32 + (index % 7) * 19;
    const sales = round(gross * quantity * (1 - discount));
    const costRatio = returned || discount >= 0.3 ? 1.08 : 0.58 + (productIndex % 3) * 0.08;
    const cost = round(sales * costRatio);
    rows.push({
      order_id: `ORD-${String(index + 1).padStart(4, '0')}`,
      order_date: `${year}-${String(month).padStart(2, '0')}-${String(1 + (index * 3) % 27).padStart(2, '0')}`,
      customer_name: `Customer ${String((index % 18) + 1).padStart(2, '0')}`,
      customer_segment: segments[index % segments.length],
      region: regions[regionIndex],
      sales_rep: reps[index % reps.length],
      product_name: products[productIndex][0],
      category: products[productIndex][1],
      quantity,
      discount,
      sales,
      cost,
      profit: round(sales - cost),
      returned,
      status: index % 9 === 0 ? 'Delayed' : index % 7 === 0 ? 'Pending' : 'Completed',
      ship_mode: shipModes[index % shipModes.length],
      delivery_days: 1 + (index % 9),
      rating: 1 + (index % 5),
    });
  }
  return rows;
}

function createSaasRows(): Row[] {
  const industries = ['Retail', 'Healthcare', 'Finance', 'Education'];
  const plans = ['Starter', 'Growth', 'Enterprise'];
  const countries = ['United Kingdom', 'United States', 'Germany', 'India'];
  const channels = ['Organic', 'Partner', 'Paid Search', 'Referral'];
  const managers = ['Nora Bell', 'Owen King', 'Priya Rao', 'Sam Reed'];
  const rows: Row[] = [];

  for (let index = 0; index < 72; index += 1) {
    const monthIndex = index % 24;
    const year = 2023 + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const planIndex = index % plans.length;
    const seats = 8 + (index % 15) * 3 + planIndex * 12;
    const monthlyRevenue = round(450 + planIndex * 900 + seats * 24 + (index % 6) * 75);
    const satisfaction = 45 + (index * 7) % 55;
    const churned = satisfaction < 55 || index % 17 === 0;
    rows.push({
      subscription_id: `SUB-${String(index + 1).padStart(4, '0')}`,
      event_date: `${year}-${String(month).padStart(2, '0')}-${String(1 + (index * 5) % 27).padStart(2, '0')}`,
      account_name: `Account ${String((index % 20) + 1).padStart(2, '0')}`,
      industry: industries[index % industries.length],
      plan: plans[planIndex],
      country: countries[(index * 3) % countries.length],
      acquisition_channel: channels[index % channels.length],
      account_manager: managers[index % managers.length],
      seats,
      monthly_revenue: monthlyRevenue,
      usage_hours: 35 + (index * 13) % 210,
      support_tickets: index % 12,
      resolution_hours: 2 + (index * 5) % 46,
      churned,
      satisfaction_score: satisfaction,
      onboarding_complete: index % 8 !== 0,
      renewal_status: churned ? 'At Risk' : index % 5 === 0 ? 'Review' : 'Renewing',
    });
  }
  return rows;
}

function createProcurementRows(): Row[] {
  const suppliers = ['Apex Components', 'Bright Logistics', 'Core Systems', 'Delta Works', 'Evergreen Services', 'Fusion Labs'];
  const departments = ['Operations', 'Technology', 'Finance', 'Facilities'];
  const countries = ['United Kingdom', 'France', 'Poland', 'Singapore'];
  const contracts = ['Fixed', 'Framework', 'Spot'];
  const buyers = ['Alex Grant', 'Fatima Noor', 'Jon Park', 'Maya Singh'];
  const rows: Row[] = [];

  for (let index = 0; index < 72; index += 1) {
    const monthIndex = index % 24;
    const year = 2023 + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const supplierIndex = index % suppliers.length;
    const risk = 15 + (index * 11) % 84;
    const approved = risk < 75 && index % 10 !== 0;
    const spend = round(900 + supplierIndex * 640 + (index % 8) * 275);
    const budget = round(1100 + supplierIndex * 610 + (index % 6) * 290);
    rows.push({
      invoice_id: `INV-${String(index + 1).padStart(4, '0')}`,
      invoice_date: `${year}-${String(month).padStart(2, '0')}-${String(1 + (index * 7) % 27).padStart(2, '0')}`,
      supplier: suppliers[supplierIndex],
      department: departments[index % departments.length],
      country: countries[(index * 3) % countries.length],
      contract_type: contracts[index % contracts.length],
      buyer: buyers[index % buyers.length],
      line_items: 1 + (index % 9),
      spend,
      budget,
      savings: round(budget - spend),
      risk_score: risk,
      approved,
      delivery_days: 2 + (index * 3) % 28,
      defect_rate: round(((index * 7) % 18) / 100),
      payment_status: index % 9 === 0 ? 'Overdue' : index % 6 === 0 ? 'On Hold' : 'Paid',
      compliance_status: approved ? 'Compliant' : 'Review',
    });
  }
  return rows;
}

const retailRows = createRetailRows();
const saasRows = createSaasRows();
const procurementRows = createProcurementRows();

const retailDataset = createDataset(
  'benchmark-spider-foundations-v1',
  'Benchmark Retail Orders',
  retailRows,
  'Retail',
  'one row per order line',
  'order_date',
  ['discount', 'delivery_days', 'rating'],
);
const saasDataset = createDataset(
  'benchmark-bird-business-v1',
  'Benchmark SaaS Accounts',
  saasRows,
  'SaaS',
  'one row per monthly account observation',
  'event_date',
  ['usage_hours', 'resolution_hours', 'satisfaction_score'],
);
const procurementDataset = createDataset(
  'benchmark-spider2-enterprise-v1',
  'Benchmark Procurement Ledger',
  procurementRows,
  'Procurement',
  'one row per invoice',
  'invoice_date',
  ['delivery_days', 'risk_score', 'defect_rate'],
);

function buildSpecs(config: SuiteFieldConfig): FixtureQuerySpec[] {
  const totalPrimary = `total_${config.primaryMetric}`;
  const averagePrimary = `average_${config.primaryMetric}`;
  const totalSecondary = `total_${config.secondaryMetric}`;
  const averageDuration = `average_${config.durationMetric}`;
  const averageScore = `average_${config.scoreMetric}`;

  const specs: FixtureQuerySpec[] = [
    { question: `What is the total ${config.primaryMetricLabel}?`, category: 'KPI', difficulty: 'easy', metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }] },
    { question: `What is the average ${config.primaryMetricLabel}?`, category: 'KPI', difficulty: 'easy', metrics: [{ field: config.primaryMetric, aggregate: 'avg', alias: averagePrimary }] },
    { question: `What is the total ${config.secondaryMetricLabel}?`, category: 'KPI', difficulty: 'easy', metrics: [{ field: config.secondaryMetric, aggregate: 'sum', alias: totalSecondary }] },
    { question: `What is the average ${config.durationLabel}?`, category: 'KPI', difficulty: 'easy', metrics: [{ field: config.durationMetric, aggregate: 'avg', alias: averageDuration }] },
    { question: `What is the highest single ${config.primaryMetricLabel} value?`, category: 'KPI', difficulty: 'easy', metrics: [{ field: config.primaryMetric, aggregate: 'max', alias: `maximum_${config.primaryMetric}` }] },
    { question: `What is the lowest ${config.scoreLabel}?`, category: 'KPI', difficulty: 'easy', metrics: [{ field: config.scoreMetric, aggregate: 'min', alias: `minimum_${config.scoreMetric}` }] },
    { question: `How many records are in this dataset?`, category: 'KPI', difficulty: 'easy', metrics: [{ aggregate: 'count', alias: 'record_count' }] },
    { question: `How many distinct ${config.entityLabel} are represented?`, category: 'KPI', difficulty: 'easy', metrics: [{ field: config.distinctField, aggregate: 'count_distinct', alias: `distinct_${config.distinctField}` }] },

    { question: `Show total ${config.primaryMetricLabel} by ${config.primaryDimensionLabel}.`, category: 'Breakdown', difficulty: 'easy', dimensions: [config.primaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }] },
    { question: `Show total ${config.primaryMetricLabel} by ${config.secondaryDimensionLabel}.`, category: 'Breakdown', difficulty: 'easy', dimensions: [config.secondaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }] },
    { question: `Break down total ${config.primaryMetricLabel} by ${config.tertiaryDimensionLabel}.`, category: 'Breakdown', difficulty: 'easy', dimensions: [config.tertiaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }] },
    { question: `Compare total ${config.primaryMetricLabel} across ${config.segmentDimensionLabel}.`, category: 'Breakdown', difficulty: 'easy', dimensions: [config.segmentDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }] },
    { question: `What is average ${config.primaryMetricLabel} by ${config.primaryDimensionLabel}?`, category: 'Breakdown', difficulty: 'medium', dimensions: [config.primaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'avg', alias: averagePrimary }] },
    { question: `What is average ${config.scoreLabel} by ${config.secondaryDimensionLabel}?`, category: 'Breakdown', difficulty: 'medium', dimensions: [config.secondaryDimension], metrics: [{ field: config.scoreMetric, aggregate: 'avg', alias: averageScore }] },
    { question: `Show total ${config.secondaryMetricLabel} by ${config.tertiaryDimensionLabel}.`, category: 'Breakdown', difficulty: 'easy', dimensions: [config.tertiaryDimension], metrics: [{ field: config.secondaryMetric, aggregate: 'sum', alias: totalSecondary }] },
    { question: `Show total ${config.quantityLabel} by ${config.segmentDimensionLabel}.`, category: 'Breakdown', difficulty: 'easy', dimensions: [config.segmentDimension], metrics: [{ field: config.quantityMetric, aggregate: 'sum', alias: `total_${config.quantityMetric}` }] },
    { question: `How many records belong to each ${config.secondaryDimensionLabel}?`, category: 'Breakdown', difficulty: 'easy', dimensions: [config.secondaryDimension], metrics: [{ aggregate: 'count', alias: 'record_count' }] },
    { question: `What is average ${config.durationLabel} by ${config.primaryDimensionLabel}?`, category: 'Breakdown', difficulty: 'medium', dimensions: [config.primaryDimension], metrics: [{ field: config.durationMetric, aggregate: 'avg', alias: averageDuration }] },

    { question: `What is total ${config.primaryMetricLabel} where ${config.booleanField.replace(/_/g, ' ')} is true?`, category: 'Filter', difficulty: 'easy', metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], filters: [{ field: config.booleanField, operator: '=', value: true }] },
    { question: `What is total ${config.primaryMetricLabel} where ${config.booleanField.replace(/_/g, ' ')} is false?`, category: 'Filter', difficulty: 'easy', metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], filters: [{ field: config.booleanField, operator: '=', value: false }] },
    { question: `Show total ${config.primaryMetricLabel} for ${config.statusValue} ${config.statusField.replace(/_/g, ' ')}.`, category: 'Filter', difficulty: 'easy', metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], filters: [{ field: config.statusField, operator: '=', value: config.statusValue }] },
    { question: `Show total ${config.primaryMetricLabel} for ${config.secondaryValue}.`, category: 'Filter', difficulty: 'easy', metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], filters: [{ field: config.secondaryDimension, operator: '=', value: config.secondaryValue }] },
    { question: `What is total ${config.secondaryMetricLabel} for ${config.tertiaryValue}?`, category: 'Filter', difficulty: 'easy', metrics: [{ field: config.secondaryMetric, aggregate: 'sum', alias: totalSecondary }], filters: [{ field: config.tertiaryDimension, operator: '=', value: config.tertiaryValue }] },
    { question: `What is total ${config.primaryMetricLabel} from ${config.midDate} onward?`, category: 'Time filter', difficulty: 'medium', metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], filters: [{ field: config.dateField, operator: '>=', value: config.midDate }] },
    { question: `How many records have ${config.scoreLabel} of at least ${config.scoreThreshold}?`, category: 'Filter', difficulty: 'medium', metrics: [{ aggregate: 'count', alias: 'record_count' }], filters: [{ field: config.scoreMetric, operator: '>=', value: config.scoreThreshold }] },
    { question: `Show average ${config.primaryMetricLabel} where ${config.durationLabel} exceeds ${config.durationThreshold}.`, category: 'Filter', difficulty: 'medium', metrics: [{ field: config.primaryMetric, aggregate: 'avg', alias: averagePrimary }], filters: [{ field: config.durationMetric, operator: '>', value: config.durationThreshold }] },
    { question: `How many records have ${config.primaryMetricLabel} above ${config.primaryThreshold}?`, category: 'Filter', difficulty: 'medium', metrics: [{ aggregate: 'count', alias: 'record_count' }], filters: [{ field: config.primaryMetric, operator: '>', value: config.primaryThreshold }] },
    { question: `Which records have negative ${config.secondaryMetricLabel}, counted by ${config.primaryDimensionLabel}?`, category: 'Filter', difficulty: 'medium', dimensions: [config.primaryDimension], metrics: [{ aggregate: 'count', alias: 'record_count' }], filters: [{ field: config.secondaryMetric, operator: '<', value: 0 }] },
    { question: `Show total ${config.primaryMetricLabel} for ${config.segmentValue} where ${config.booleanField.replace(/_/g, ' ')} is true.`, category: 'Multi-filter', difficulty: 'hard', metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], filters: [{ field: config.segmentDimension, operator: '=', value: config.segmentValue }, { field: config.booleanField, operator: '=', value: true }] },
    { question: `Show total ${config.primaryMetricLabel} for ${config.tertiaryValue} records in ${config.secondaryValue}.`, category: 'Multi-filter', difficulty: 'hard', dimensions: [config.tertiaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], filters: [{ field: config.secondaryDimension, operator: '=', value: config.secondaryValue }, { field: config.tertiaryDimension, operator: '=', value: config.tertiaryValue }] },

    { question: `Which 5 ${config.primaryDimensionLabel} have the highest ${config.primaryMetricLabel}?`, category: 'Ranking', difficulty: 'easy', dimensions: [config.primaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], orderBy: [{ field: totalPrimary, direction: 'desc' }, { field: config.primaryDimension, direction: 'asc' }], limit: 5, orderMatters: true },
    { question: `Which 3 ${config.secondaryDimensionLabel} have the lowest ${config.primaryMetricLabel}?`, category: 'Ranking', difficulty: 'easy', dimensions: [config.secondaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], orderBy: [{ field: totalPrimary, direction: 'asc' }, { field: config.secondaryDimension, direction: 'asc' }], limit: 3, orderMatters: true },
    { question: `Rank ${config.tertiaryDimensionLabel} by total ${config.secondaryMetricLabel}, highest first.`, category: 'Ranking', difficulty: 'medium', dimensions: [config.tertiaryDimension], metrics: [{ field: config.secondaryMetric, aggregate: 'sum', alias: totalSecondary }], orderBy: [{ field: totalSecondary, direction: 'desc' }, { field: config.tertiaryDimension, direction: 'asc' }], orderMatters: true },
    { question: `Show the top 4 ${config.segmentDimensionLabel} by average ${config.scoreLabel}.`, category: 'Ranking', difficulty: 'medium', dimensions: [config.segmentDimension], metrics: [{ field: config.scoreMetric, aggregate: 'avg', alias: averageScore }], orderBy: [{ field: averageScore, direction: 'desc' }, { field: config.segmentDimension, direction: 'asc' }], limit: 4, orderMatters: true },
    { question: `Which 5 ${config.primaryDimensionLabel} have the shortest average ${config.durationLabel}?`, category: 'Ranking', difficulty: 'medium', dimensions: [config.primaryDimension], metrics: [{ field: config.durationMetric, aggregate: 'avg', alias: averageDuration }], orderBy: [{ field: averageDuration, direction: 'asc' }, { field: config.primaryDimension, direction: 'asc' }], limit: 5, orderMatters: true },
    { question: `Rank ${config.secondaryDimensionLabel} by record count, largest first.`, category: 'Ranking', difficulty: 'easy', dimensions: [config.secondaryDimension], metrics: [{ aggregate: 'count', alias: 'record_count' }], orderBy: [{ field: 'record_count', direction: 'desc' }, { field: config.secondaryDimension, direction: 'asc' }], orderMatters: true },
    { question: `Which 5 ${config.primaryDimensionLabel} have the highest average ${config.primaryMetricLabel}?`, category: 'Ranking', difficulty: 'medium', dimensions: [config.primaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'avg', alias: averagePrimary }], orderBy: [{ field: averagePrimary, direction: 'desc' }, { field: config.primaryDimension, direction: 'asc' }], limit: 5, orderMatters: true },
    { question: `Show the bottom 4 ${config.primaryDimensionLabel} by total ${config.secondaryMetricLabel}.`, category: 'Ranking', difficulty: 'medium', dimensions: [config.primaryDimension], metrics: [{ field: config.secondaryMetric, aggregate: 'sum', alias: totalSecondary }], orderBy: [{ field: totalSecondary, direction: 'asc' }, { field: config.primaryDimension, direction: 'asc' }], limit: 4, orderMatters: true },
    { question: `Which 3 ${config.tertiaryDimensionLabel} have the highest total ${config.quantityLabel}?`, category: 'Ranking', difficulty: 'medium', dimensions: [config.tertiaryDimension], metrics: [{ field: config.quantityMetric, aggregate: 'sum', alias: `total_${config.quantityMetric}` }], orderBy: [{ field: `total_${config.quantityMetric}`, direction: 'desc' }, { field: config.tertiaryDimension, direction: 'asc' }], limit: 3, orderMatters: true },
    { question: `List ${config.segmentDimensionLabel} alphabetically with total ${config.primaryMetricLabel}.`, category: 'Sorting', difficulty: 'easy', dimensions: [config.segmentDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], orderBy: [{ field: config.segmentDimension, direction: 'asc' }], orderMatters: true },

    { question: `Which ${config.primaryDimensionLabel} have total ${config.primaryMetricLabel} above ${config.primaryThreshold}?`, category: 'Aggregate filter', difficulty: 'hard', dimensions: [config.primaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], having: { alias: totalPrimary, operator: '>', value: config.primaryThreshold }, orderBy: [{ field: totalPrimary, direction: 'desc' }], orderMatters: true },
    { question: `Which ${config.secondaryDimensionLabel} have average ${config.scoreLabel} at least ${config.scoreThreshold}?`, category: 'Aggregate filter', difficulty: 'hard', dimensions: [config.secondaryDimension], metrics: [{ field: config.scoreMetric, aggregate: 'avg', alias: averageScore }], having: { alias: averageScore, operator: '>=', value: config.scoreThreshold } },
    { question: `Which ${config.tertiaryDimensionLabel} have total ${config.secondaryMetricLabel} below ${config.secondaryThreshold}?`, category: 'Aggregate filter', difficulty: 'hard', dimensions: [config.tertiaryDimension], metrics: [{ field: config.secondaryMetric, aggregate: 'sum', alias: totalSecondary }], having: { alias: totalSecondary, operator: '<', value: config.secondaryThreshold } },
    { question: `Which ${config.primaryDimensionLabel} appear in at least 5 records?`, category: 'Aggregate filter', difficulty: 'hard', dimensions: [config.primaryDimension], metrics: [{ aggregate: 'count', alias: 'record_count' }], having: { alias: 'record_count', operator: '>=', value: 5 } },
    { question: `Which ${config.segmentDimensionLabel} have average ${config.durationLabel} below ${config.durationThreshold}?`, category: 'Aggregate filter', difficulty: 'hard', dimensions: [config.segmentDimension], metrics: [{ field: config.durationMetric, aggregate: 'avg', alias: averageDuration }], having: { alias: averageDuration, operator: '<', value: config.durationThreshold } },

    { question: `Show both total ${config.primaryMetricLabel} and total ${config.secondaryMetricLabel} by ${config.primaryDimensionLabel}.`, category: 'Multi-metric', difficulty: 'hard', dimensions: [config.primaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }, { field: config.secondaryMetric, aggregate: 'sum', alias: totalSecondary }], orderBy: [{ field: totalPrimary, direction: 'desc' }], orderMatters: true },
    { question: `How many distinct ${config.entityLabel} are in each ${config.secondaryDimensionLabel}?`, category: 'Distinct', difficulty: 'medium', dimensions: [config.secondaryDimension], metrics: [{ field: config.distinctField, aggregate: 'count_distinct', alias: `distinct_${config.distinctField}` }] },
    { question: `What was total ${config.primaryMetricLabel} between ${config.startDate} and ${config.endDate}?`, category: 'Time filter', difficulty: 'medium', metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], filters: [{ field: config.dateField, operator: 'between', value: [config.startDate, config.endDate] }] },
    { question: `Which ${config.primaryDimensionLabel} has the highest average ${config.scoreLabel}?`, category: 'Ranking', difficulty: 'hard', dimensions: [config.primaryDimension], metrics: [{ field: config.scoreMetric, aggregate: 'avg', alias: averageScore }], orderBy: [{ field: averageScore, direction: 'desc' }, { field: config.primaryDimension, direction: 'asc' }], limit: 1, orderMatters: true },
    { question: `Show the top 10 ${config.primaryDimensionLabel} and ${config.secondaryDimensionLabel} combinations by ${config.primaryMetricLabel}.`, category: 'Multi-dimensional', difficulty: 'hard', dimensions: [config.primaryDimension, config.secondaryDimension], metrics: [{ field: config.primaryMetric, aggregate: 'sum', alias: totalPrimary }], orderBy: [{ field: totalPrimary, direction: 'desc' }, { field: config.primaryDimension, direction: 'asc' }], limit: 10, orderMatters: true },
  ];

  if (specs.length !== 50) throw new Error(`Benchmark suite ${config.suiteId} must contain exactly 50 specifications; received ${specs.length}.`);
  return specs;
}

function createCases(suiteId: BenchmarkSuiteId, dataset: Dataset, rows: Row[], specs: FixtureQuerySpec[]): BenchmarkCase[] {
  return specs.map((spec, index) => ({
    id: `${suiteId}-${String(index + 1).padStart(3, '0')}`,
    suiteId,
    sourceId: `${suiteId}-curated-${String(index + 1).padStart(3, '0')}`,
    question: spec.question,
    category: spec.category,
    difficulty: spec.difficulty,
    dataset,
    goldSql: compileGoldSql(spec),
    expectedRows: materializeExpectedRows(rows, spec),
    comparison: {
      orderMatters: Boolean(spec.orderMatters),
      strictColumns: false,
      absoluteTolerance: 1e-5,
      relativeTolerance: 1e-4,
    },
    tags: [...(spec.tags || []), spec.category.toLowerCase().replace(/\s+/g, '-')],
  }));
}

const retailConfig: SuiteFieldConfig = {
  suiteId: 'spider-compatible', entityLabel: 'customers',
  primaryMetric: 'sales', primaryMetricLabel: 'sales', secondaryMetric: 'profit', secondaryMetricLabel: 'profit',
  quantityMetric: 'quantity', quantityLabel: 'quantity', durationMetric: 'delivery_days', durationLabel: 'delivery time',
  scoreMetric: 'rating', scoreLabel: 'rating', dateField: 'order_date',
  primaryDimension: 'product_name', primaryDimensionLabel: 'products', secondaryDimension: 'region', secondaryDimensionLabel: 'regions',
  tertiaryDimension: 'category', tertiaryDimensionLabel: 'categories', segmentDimension: 'customer_segment', segmentDimensionLabel: 'customer segments',
  statusField: 'status', statusValue: 'Delayed', booleanField: 'returned', distinctField: 'customer_name',
  secondaryValue: 'North', tertiaryValue: 'Technology', segmentValue: 'Consumer',
  startDate: '2024-01-01', midDate: '2024-01-01', endDate: '2024-12-31',
  primaryThreshold: 10_000, secondaryThreshold: 2_000, scoreThreshold: 4, durationThreshold: 6,
};

const saasConfig: SuiteFieldConfig = {
  suiteId: 'bird-compatible', entityLabel: 'accounts',
  primaryMetric: 'monthly_revenue', primaryMetricLabel: 'monthly recurring revenue', secondaryMetric: 'usage_hours', secondaryMetricLabel: 'usage hours',
  quantityMetric: 'seats', quantityLabel: 'licensed seats', durationMetric: 'resolution_hours', durationLabel: 'resolution time',
  scoreMetric: 'satisfaction_score', scoreLabel: 'satisfaction score', dateField: 'event_date',
  primaryDimension: 'account_name', primaryDimensionLabel: 'accounts', secondaryDimension: 'industry', secondaryDimensionLabel: 'industries',
  tertiaryDimension: 'plan', tertiaryDimensionLabel: 'plans', segmentDimension: 'country', segmentDimensionLabel: 'countries',
  statusField: 'renewal_status', statusValue: 'At Risk', booleanField: 'churned', distinctField: 'account_name',
  secondaryValue: 'Retail', tertiaryValue: 'Enterprise', segmentValue: 'United Kingdom',
  startDate: '2024-01-01', midDate: '2024-01-01', endDate: '2024-12-31',
  primaryThreshold: 8_000, secondaryThreshold: 4_000, scoreThreshold: 70, durationThreshold: 24,
};

const procurementConfig: SuiteFieldConfig = {
  suiteId: 'spider2-compatible', entityLabel: 'suppliers',
  primaryMetric: 'spend', primaryMetricLabel: 'spend', secondaryMetric: 'savings', secondaryMetricLabel: 'savings',
  quantityMetric: 'line_items', quantityLabel: 'line items', durationMetric: 'delivery_days', durationLabel: 'delivery time',
  scoreMetric: 'risk_score', scoreLabel: 'risk score', dateField: 'invoice_date',
  primaryDimension: 'supplier', primaryDimensionLabel: 'suppliers', secondaryDimension: 'department', secondaryDimensionLabel: 'departments',
  tertiaryDimension: 'contract_type', tertiaryDimensionLabel: 'contract types', segmentDimension: 'country', segmentDimensionLabel: 'countries',
  statusField: 'payment_status', statusValue: 'Overdue', booleanField: 'approved', distinctField: 'supplier',
  secondaryValue: 'Technology', tertiaryValue: 'Framework', segmentValue: 'United Kingdom',
  startDate: '2024-01-01', midDate: '2024-01-01', endDate: '2024-12-31',
  primaryThreshold: 30_000, secondaryThreshold: 5_000, scoreThreshold: 60, durationThreshold: 18,
};

const retailCases = createCases('spider-compatible', retailDataset, retailRows, buildSpecs(retailConfig));
const saasCases = createCases('bird-compatible', saasDataset, saasRows, buildSpecs(saasConfig));
const procurementCases = createCases('spider2-compatible', procurementDataset, procurementRows, buildSpecs(procurementConfig));

export const BENCHMARK_SUITES: BenchmarkSuite[] = [
  {
    id: 'spider-compatible',
    name: 'Spider-Compatible Foundations',
    shortName: 'Foundations',
    version: '1.0.0',
    description: '50 schema-grounded questions covering aggregation, filters, grouping, sorting, dates, distinct counts, and Top-N.',
    methodology: 'A deterministic compatibility pack inspired by Spider task families and adapted to QuickInsight\'s local DuckDB execution model.',
    accent: 'violet',
    attribution: {
      benchmark: 'Spider 1.0', homepage: 'https://yale-lily.github.io/spider', license: 'CC BY-SA 4.0',
      notice: 'Curated compatibility pack. It is not the official Spider development/test set and must not be reported as an official leaderboard score.',
    },
    cases: retailCases,
  },
  {
    id: 'bird-compatible',
    name: 'BIRD-Compatible Business Reasoning',
    shortName: 'Business reasoning',
    version: '1.0.0',
    description: '50 business-language questions with value filters, operational metrics, rankings, and aggregate constraints.',
    methodology: 'A deterministic compatibility pack inspired by BIRD business reasoning patterns, with synthetic non-PII data and frozen gold outputs.',
    accent: 'cyan',
    attribution: {
      benchmark: 'BIRD', homepage: 'https://bird-bench.github.io/', license: 'CC BY-SA 4.0',
      notice: 'Curated compatibility pack. It is not the official BIRD development/test set and must not be reported as an official leaderboard score.',
    },
    cases: saasCases,
  },
  {
    id: 'spider2-compatible',
    name: 'Spider 2.0-Compatible Enterprise Robustness',
    shortName: 'Enterprise robustness',
    version: '1.0.0',
    description: '50 enterprise-style procurement questions spanning multi-condition, multi-metric, aggregate filtering, and ranked outputs.',
    methodology: 'A DuckDB-compatible enterprise pack inspired by Spider 2.0 task complexity. It deliberately avoids warehouse-specific Snowflake/BigQuery features.',
    accent: 'amber',
    attribution: {
      benchmark: 'Spider 2.0', homepage: 'https://spider2-sql.github.io/', license: 'Repository-specific/open benchmark terms',
      notice: 'Curated compatibility pack. It is not the official Spider 2.0 test set and must not be reported as an official leaderboard score.',
    },
    cases: procurementCases,
  },
];

export const ALL_BENCHMARK_CASES: BenchmarkCase[] = BENCHMARK_SUITES.flatMap(suite => suite.cases);

export function getBenchmarkSuite(id: BenchmarkSuiteId): BenchmarkSuite | undefined {
  return BENCHMARK_SUITES.find(suite => suite.id === id);
}
