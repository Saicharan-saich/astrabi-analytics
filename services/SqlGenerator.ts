
import { escapeStringValue } from './analysisValidator';

export interface SqlQueryConfig {
    metric: string;
    aggregation: string;
    dimension?: string;
    secondaryDimensions?: string[]; // Additional grouping dimensions
    table: string;
    dateColumn?: string; // Actual date column name from dataset (e.g., 'sale_date')
    timeFilter?: string;
    filters?: Record<string, string[]>;
    measureFilters?: Array<{ column: string; operator: string; value: number }>;
    sort?: string; // 'desc', 'asc', 'oldest', 'newest'
    limit?: number;
    dates: {
        today: string;
        yesterday: string;
        this_week_start: string;
        this_month_start: string;
        this_quarter_start: string;
        year_start: string;
        last_30_days: string;
        last_90_days: string;
    };
}

// Whitelist of allowed aggregation functions
const ALLOWED_AGGREGATIONS = new Set(['SUM', 'AVG', 'COUNT', 'MAX', 'MIN', 'COUNT_DISTINCT']);

// Whitelist of allowed operators for measure filters
const ALLOWED_OPERATORS = new Set(['>', '<', '>=', '<=', '=', '!=', '<>']);

// Maximum LIMIT ceiling
const MAX_LIMIT = 10000;

/**
 * Safely quote an identifier (column/table name) for SQL.
 * Preserve field identity; escape embedded quotes instead of deleting characters.
 */
function safeId(name: string): string {
    if (!name) return '"unnamed"';
    if (name.includes('\0')) throw new Error('SQL identifiers cannot contain a null character');
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Safely format a date string for SQL.
 * Only allows YYYY-MM-DD format.
 */
function safeDate(dateStr: string): string {
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "'1970-01-01'"; // Safe fallback
    return `'${escapeStringValue(dateStr)}'`;
}

export class SqlGenerator {
    private config: SqlQueryConfig;

    constructor(config: SqlQueryConfig) {
        this.config = config;
    }

    public build(): string {
        const select = this.buildSelect();
        const from = `FROM ${safeId(this.config.table)}`;
        const where = this.buildWhere();
        const groupBy = this.buildGroupBy();
        const orderBy = this.buildOrderBy();
        const limit = this.buildLimit();

        return [select, from, where, groupBy, orderBy, limit].filter(Boolean).join(' ').trim();
    }

    private buildSelect(): string {
        const { metric, aggregation, dimension, secondaryDimensions } = this.config;
        // Validate aggregation against whitelist
        const aggUpper = (aggregation || 'SUM').toUpperCase();
        const aggFunc = ALLOWED_AGGREGATIONS.has(aggUpper) ? aggUpper : 'SUM';

        const metricId = metric === '*' ? '*' : safeId(metric || '*');
        const metricExp = `${aggFunc}(${metricId})`;

        const dimCols: string[] = [];
        if (dimension) dimCols.push(safeId(dimension));
        if (secondaryDimensions && secondaryDimensions.length > 0) {
            secondaryDimensions.forEach(sd => dimCols.push(safeId(sd)));
        }

        if (dimCols.length > 0) {
            return `SELECT ${dimCols.join(', ')}, ${metricExp}`;
        }
        return `SELECT ${metricExp}`;
    }

    private buildWhere(): string {
        const clauses: string[] = [];
        const { timeFilter, filters, measureFilters, dates, dateColumn } = this.config;
        // Use actual date column name from dataset, fallback to 'date'
        const dateRef = safeId(dateColumn || 'date');

        // 1. Time Filter — all dates go through safeDate()
        if (timeFilter && timeFilter !== 'all_time') {
            if (timeFilter === 'today') {
                clauses.push(`${dateRef} = ${safeDate(dates.today)}`);
            } else if (timeFilter === 'yesterday') {
                clauses.push(`${dateRef} = ${safeDate(dates.yesterday)}`);
            } else if (timeFilter === 'this_week') {
                clauses.push(`${dateRef} >= ${safeDate(dates.this_week_start)}`);
            } else if (timeFilter === 'this_month') {
                clauses.push(`${dateRef} >= ${safeDate(dates.this_month_start)}`);
            } else if (timeFilter === 'this_quarter') {
                clauses.push(`${dateRef} >= ${safeDate(dates.this_quarter_start)}`);
            } else if (timeFilter === 'this_year') {
                clauses.push(`${dateRef} >= ${safeDate(dates.year_start)}`);
            } else if (timeFilter === 'last_30_days') {
                clauses.push(`${dateRef} >= ${safeDate(dates.last_30_days)}`);
            } else if (timeFilter === 'last_90_days') {
                clauses.push(`${dateRef} >= ${safeDate(dates.last_90_days)}`);
            } else if (timeFilter.startsWith('last_')) {
                // Dynamic parsing for last_N_days/weeks/months/years/cyears
                const match = timeFilter.match(/^last_(\d+)_(c?[a-z]+)$/);
                if (match) {
                    const n = Math.min(parseInt(match[1], 10), 3650); // Cap at 10 years
                    const unit = match[2];
                    const today = new Date(`${dates.today}T00:00:00Z`);

                    if (unit === 'cyears') {
                        // Calendar year mode: full previous calendar years
                        const asOfYear = today.getUTCFullYear();
                        const startDate = new Date(Date.UTC(asOfYear - n, 0, 1)).toISOString().split('T')[0];
                        const endDate = new Date(Date.UTC(asOfYear - 1, 11, 31)).toISOString().split('T')[0];
                        clauses.push(`${dateRef} BETWEEN ${safeDate(startDate)} AND ${safeDate(endDate)}`);
                    } else {
                        const targetDate = new Date(today);
                        if (unit === 'days') {
                            targetDate.setUTCDate(today.getUTCDate() - n);
                        } else if (unit === 'weeks') {
                            targetDate.setUTCDate(today.getUTCDate() - (n * 7));
                        } else if (unit === 'months') {
                            targetDate.setUTCMonth(today.getUTCMonth() - n);
                        } else if (unit === 'years') {
                            targetDate.setUTCFullYear(today.getUTCFullYear() - n);
                        }
                        const startDate = targetDate.toISOString().split('T')[0];
                        clauses.push(`${dateRef} >= ${safeDate(startDate)}`);
                    }
                } else {
                    clauses.push(`${dateRef} >= ${safeDate(dates.last_30_days)}`); // Fallback
                }
            }
        }

        // 2. Dimension Filters — sanitize column names and escape values
        if (filters) {
            Object.entries(filters).forEach(([col, vals]) => {
                if (vals.length > 0) {
                    const valList = vals.map(v => `'${escapeStringValue(String(v))}'`).join(', ');
                    clauses.push(`${safeId(col)} IN (${valList})`);
                }
            });
        }

        // 3. Measure Filters — validate operators, sanitize column names, ensure numeric values
        if (measureFilters) {
            measureFilters.forEach(mf => {
                const op = ALLOWED_OPERATORS.has(mf.operator) ? mf.operator : '>';
                const val = isFinite(mf.value) ? mf.value : 0;
                clauses.push(`${safeId(mf.column)} ${op} ${val}`);
            });
        }

        if (clauses.length === 0) return '';
        return `WHERE ${clauses.join(' AND ')}`;
    }

    private buildGroupBy(): string {
        const { dimension, secondaryDimensions } = this.config;
        const dims: string[] = [];
        if (dimension) dims.push(safeId(dimension));
        if (secondaryDimensions && secondaryDimensions.length > 0) {
            secondaryDimensions.forEach(sd => dims.push(safeId(sd)));
        }
        if (dims.length > 0) {
            return `GROUP BY ${dims.join(', ')}`;
        }
        return '';
    }

    private buildOrderBy(): string {
        const { sort, dimension, metric, aggregation } = this.config;

        // Reconstruct the exact aggregate expression used in SELECT
        const aggUpper = (aggregation || 'SUM').toUpperCase();
        const aggFunc = ALLOWED_AGGREGATIONS.has(aggUpper) ? aggUpper : 'SUM';
        const metricId = metric === '*' ? '*' : safeId(metric || '*');
        const metricExp = `${aggFunc}(${metricId})`;

        if (sort === 'oldest') {
            return dimension ? `ORDER BY ${safeId(dimension)} ASC` : '';
        } else if (sort === 'newest') {
            return dimension ? `ORDER BY ${safeId(dimension)} DESC` : '';
        } else if (sort === 'asc') {
            return `ORDER BY ${metricExp} ASC`;
        } else {
            // Default desc
            return `ORDER BY ${metricExp} DESC`;
        }
    }

    private buildLimit(): string {
        if (this.config.limit && this.config.limit > 0) {
            const clamped = Math.min(this.config.limit, MAX_LIMIT);
            return `LIMIT ${clamped}`;
        }
        return `LIMIT 1000`; // Safe default
    }
}
