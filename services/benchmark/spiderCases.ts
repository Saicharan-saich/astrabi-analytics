/**
 * Spider & Spider 2.0 style text-to-SQL benchmark cases.
 * ─────────────────────────────────────────────────────────
 * These are SELF-CONTAINED, DuckDB-runnable cases written in the SPIRIT of the
 * Spider (Yu et al., 2018) and Spider 2.0 (Lei et al., 2024) benchmarks — the
 * same query *patterns* (aggregates, GROUP BY … HAVING, ORDER BY … LIMIT,
 * multi-table JOINs, nested subqueries, window functions) over small synthetic
 * databases so every gold answer is deterministically checkable offline.
 *
 * They are NOT the official Spider/Spider2 splits: those ship ~200 SQLite
 * databases (Spider) and cloud-warehouse workloads on BigQuery/Snowflake
 * (Spider 2.0) that cannot be bundled into a browser app. A `loadOfficialSpider`
 * adapter hook is provided so the real dev JSON + databases can be plugged in
 * later behind the exact same runner.
 *
 * HOW THIS MAPS TO *THIS* APP'S ARCHITECTURE:
 *   QuickInsight handles multiple tables by DENORMALIZING them up front —
 *   `autoJoinDatasets` merges the source tables into ONE master table (a
 *   fact-first LEFT JOIN cascade), and the AI-SQL pipeline then answers over
 *   that single wide table (the "One Big Table" pattern). So the benchmark
 *   runner replicates the real path: for multi-table cases it builds the master
 *   table with the SAME join engine the connector uses, then runs the pipeline
 *   on it. `joinEdges` below define those joins.
 *
 *   The single- vs multi-table split is still reported, because the join +
 *   denormalize step is exactly where aggregation correctness can go wrong
 *   (join fan-out changing the grain), so it is worth measuring on its own.
 */

import type { JoinEdge } from '../analysisEngine';

export type Suite = 'spider' | 'spider2' | 'bird' | 'internal' | 'user';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'extra';

export interface BenchTable {
    name: string;
    rows: Record<string, any>[];
}

export interface BenchCase {
    id: string;
    suite: Suite;
    db: string;
    question: string;
    /** Gold SQL — plain DuckDB dialect, runs against the case's `tables`. */
    goldSQL: string;
    difficulty: Difficulty;
    /** Number of tables the GOLD query touches (1 = single-table sweet spot). */
    tableCount: number;
    /** All tables in this mini-database. */
    tables: BenchTable[];
    /** The table handed to the pipeline for SINGLE-table cases. For multi-table
     *  cases the pipeline instead receives the denormalized master table. */
    primaryTable: string;
    /** Join edges used to denormalize multi-table cases into one master table
     *  (via the app's autoJoinDatasets). Required when tableCount > 1. */
    joinEdges?: JoinEdge[];
    /** True when the gold query's ORDER BY makes row order significant. */
    orderMatters?: boolean;
    tags: string[];
}

// ── Shared mini-databases ────────────────────────────────────────────

const singer: BenchTable = {
    name: 'singer',
    rows: [
        { singer_id: 1, name: 'Aria Blue', country: 'France', age: 52, is_male: 0 },
        { singer_id: 2, name: 'John Reed', country: 'USA', age: 34, is_male: 1 },
        { singer_id: 3, name: 'Mia Stone', country: 'France', age: 41, is_male: 0 },
        { singer_id: 4, name: 'Leo Park', country: 'USA', age: 29, is_male: 1 },
        { singer_id: 5, name: 'Nina Cruz', country: 'Netherlands', age: 45, is_male: 0 },
        { singer_id: 6, name: 'Omar Vale', country: 'France', age: 63, is_male: 1 },
    ],
};

const stadium: BenchTable = {
    name: 'stadium',
    rows: [
        { stadium_id: 1, name: 'Highfield', capacity: 52000, city: 'Lyon' },
        { stadium_id: 2, name: 'Grand Arena', capacity: 78000, city: 'Paris' },
        { stadium_id: 3, name: 'Sea Park', capacity: 41000, city: 'Nice' },
    ],
};

// concert is the fact for [stadium, concert] cases — kept unambiguously larger
// than stadium so the fact-first join bases on concert (each concert → 1 stadium).
const concert: BenchTable = {
    name: 'concert',
    rows: [
        { concert_id: 1, concert_name: 'Gala', theme: 'Classic', stadium_id: 2, year: 2023 },
        { concert_id: 2, concert_name: 'Summer Fest', theme: 'Pop', stadium_id: 1, year: 2023 },
        { concert_id: 3, concert_name: 'Winter Night', theme: 'Jazz', stadium_id: 2, year: 2024 },
        { concert_id: 4, concert_name: 'Spring Show', theme: 'Pop', stadium_id: 1, year: 2024 },
        { concert_id: 5, concert_name: 'Night Fever', theme: 'Jazz', stadium_id: 2, year: 2024 },
    ],
};

// The bridge (many-to-many) is the fact for the singers-in-concert case — kept
// larger than both singer and concert so the join bases on it (1 row per
// performance → 1 singer + 1 concert), which is the correct grain.
const singerInConcert: BenchTable = {
    name: 'singer_in_concert',
    rows: [
        { concert_id: 1, singer_id: 1 },
        { concert_id: 1, singer_id: 3 },
        { concert_id: 1, singer_id: 6 },
        { concert_id: 2, singer_id: 2 },
        { concert_id: 3, singer_id: 1 },
        { concert_id: 3, singer_id: 5 },
        { concert_id: 4, singer_id: 4 },
        { concert_id: 5, singer_id: 5 },
    ],
};

const employee: BenchTable = {
    name: 'employee',
    rows: [
        { employee_id: 1, name: 'Sara', department: 'Sales', salary: 62000, shop_id: 1 },
        { employee_id: 2, name: 'Tom', department: 'Sales', salary: 58000, shop_id: 1 },
        { employee_id: 3, name: 'Uma', department: 'Sales', salary: 71000, shop_id: 2 },
        { employee_id: 4, name: 'Vik', department: 'Engineering', salary: 95000, shop_id: 2 },
        { employee_id: 5, name: 'Wes', department: 'Engineering', salary: 88000, shop_id: 3 },
        { employee_id: 6, name: 'Xena', department: 'Support', salary: 47000, shop_id: 1 },
        { employee_id: 7, name: 'Yani', department: 'Support', salary: 51000, shop_id: 3 },
    ],
};

const shop: BenchTable = {
    name: 'shop',
    rows: [
        { shop_id: 1, shop_name: 'Downtown', district: 'Central' },
        { shop_id: 2, shop_name: 'Uptown', district: 'North' },
        { shop_id: 3, shop_name: 'Riverside', district: 'East' },
    ],
};

const product: BenchTable = {
    name: 'product',
    rows: [
        { product_id: 1, product_name: 'Widget', category: 'Hardware', price: 25, units_sold: 400 },
        { product_id: 2, product_name: 'Gadget', category: 'Hardware', price: 60, units_sold: 150 },
        { product_id: 3, product_name: 'Cloud Plan', category: 'Software', price: 120, units_sold: 300 },
        { product_id: 4, product_name: 'Support Pack', category: 'Software', price: 40, units_sold: 220 },
        { product_id: 5, product_name: 'Cable', category: 'Hardware', price: 8, units_sold: 900 },
    ],
};

const customer: BenchTable = {
    name: 'customer',
    rows: [
        { customer_id: 1, customer_name: 'Acme', country: 'USA' },
        { customer_id: 2, customer_name: 'Globex', country: 'UK' },
        { customer_id: 3, customer_name: 'Initech', country: 'USA' },
    ],
};

const orders: BenchTable = {
    name: 'orders',
    rows: [
        { order_id: 1, customer_id: 1, amount: 500, order_date: '2024-01-15' },
        { order_id: 2, customer_id: 1, amount: 300, order_date: '2024-02-10' },
        { order_id: 3, customer_id: 2, amount: 900, order_date: '2024-02-20' },
        { order_id: 4, customer_id: 1, amount: 250, order_date: '2024-03-05' },
        { order_id: 5, customer_id: 3, amount: 700, order_date: '2024-03-18' },
    ],
};

const monthlySales: BenchTable = {
    name: 'monthly_sales',
    rows: [
        { month: '2024-01', revenue: 1000 },
        { month: '2024-02', revenue: 1200 },
        { month: '2024-03', revenue: 900 },
        { month: '2024-04', revenue: 1500 },
        { month: '2024-05', revenue: 1700 },
    ],
};

// ── The cases ────────────────────────────────────────────────────────

export const BENCHMARK_CASES: BenchCase[] = [
    // ————— SPIDER-STYLE, single-table (engine's design envelope) —————
    {
        id: 'spider-singer-count', suite: 'spider', db: 'concert_singer',
        question: 'How many singers are there?',
        goldSQL: 'SELECT COUNT(*) AS n FROM singer',
        difficulty: 'easy', tableCount: 1, tables: [singer], primaryTable: 'singer',
        tags: ['aggregate', 'count'],
    },
    {
        id: 'spider-singer-avg-age', suite: 'spider', db: 'concert_singer',
        question: 'What is the average age of all singers?',
        goldSQL: 'SELECT AVG(age) AS avg_age FROM singer',
        difficulty: 'easy', tableCount: 1, tables: [singer], primaryTable: 'singer',
        tags: ['aggregate', 'avg'],
    },
    {
        id: 'spider-singer-distinct-country', suite: 'spider', db: 'concert_singer',
        question: 'What are the distinct countries the singers are from?',
        goldSQL: 'SELECT DISTINCT country FROM singer',
        difficulty: 'easy', tableCount: 1, tables: [singer], primaryTable: 'singer',
        tags: ['distinct'],
    },
    {
        id: 'spider-singer-older-40', suite: 'spider', db: 'concert_singer',
        question: 'List the names of singers older than 40, from oldest to youngest.',
        goldSQL: 'SELECT name FROM singer WHERE age > 40 ORDER BY age DESC',
        difficulty: 'medium', tableCount: 1, tables: [singer], primaryTable: 'singer',
        orderMatters: true, tags: ['filter', 'order'],
    },
    {
        id: 'spider-singer-count-by-country', suite: 'spider', db: 'concert_singer',
        question: 'How many singers are there from each country?',
        goldSQL: 'SELECT country, COUNT(*) AS n FROM singer GROUP BY country',
        difficulty: 'medium', tableCount: 1, tables: [singer], primaryTable: 'singer',
        tags: ['group_by', 'count'],
    },
    {
        id: 'spider-emp-count-by-dept', suite: 'spider', db: 'company',
        question: 'Count the number of employees in each department.',
        goldSQL: 'SELECT department, COUNT(*) AS n FROM employee GROUP BY department',
        difficulty: 'medium', tableCount: 1, tables: [employee], primaryTable: 'employee',
        tags: ['group_by', 'count'],
    },
    {
        id: 'spider-emp-dept-most', suite: 'spider', db: 'company',
        question: 'Which department has the most employees? Give the department name.',
        goldSQL: 'SELECT department FROM employee GROUP BY department ORDER BY COUNT(*) DESC LIMIT 1',
        difficulty: 'medium', tableCount: 1, tables: [employee], primaryTable: 'employee',
        orderMatters: true, tags: ['group_by', 'order', 'limit'],
    },
    {
        id: 'spider-emp-dept-having', suite: 'spider', db: 'company',
        question: 'Which departments have more than 2 employees?',
        goldSQL: 'SELECT department FROM employee GROUP BY department HAVING COUNT(*) > 2',
        difficulty: 'hard', tableCount: 1, tables: [employee], primaryTable: 'employee',
        tags: ['group_by', 'having'],
    },
    {
        id: 'spider-emp-avg-salary-by-dept', suite: 'spider', db: 'company',
        question: 'What is the average salary in each department?',
        goldSQL: 'SELECT department, AVG(salary) AS avg_salary FROM employee GROUP BY department',
        difficulty: 'medium', tableCount: 1, tables: [employee], primaryTable: 'employee',
        tags: ['group_by', 'avg'],
    },
    {
        id: 'spider-product-total-revenue', suite: 'spider', db: 'store',
        question: 'What is the total revenue across all products (price times units sold)?',
        goldSQL: 'SELECT SUM(price * units_sold) AS total_revenue FROM product',
        difficulty: 'medium', tableCount: 1, tables: [product], primaryTable: 'product',
        tags: ['aggregate', 'derived'],
    },
    {
        id: 'spider-product-top3-price', suite: 'spider', db: 'store',
        question: 'What are the names of the 3 most expensive products?',
        goldSQL: 'SELECT product_name FROM product ORDER BY price DESC LIMIT 3',
        difficulty: 'medium', tableCount: 1, tables: [product], primaryTable: 'product',
        orderMatters: true, tags: ['order', 'limit'],
    },
    {
        id: 'spider-product-revenue-by-category', suite: 'spider', db: 'store',
        question: 'What is the total revenue for each product category?',
        goldSQL: 'SELECT category, SUM(price * units_sold) AS revenue FROM product GROUP BY category',
        difficulty: 'hard', tableCount: 1, tables: [product], primaryTable: 'product',
        tags: ['group_by', 'derived'],
    },

    // ————— SPIDER-STYLE, multi-table JOINs (outside single-table envelope) —————
    {
        id: 'spider-concert-stadium-join', suite: 'spider', db: 'concert_singer',
        question: 'Show the distinct names of stadiums that have hosted a concert.',
        goldSQL: 'SELECT DISTINCT s.name FROM stadium s JOIN concert c ON s.stadium_id = c.stadium_id',
        difficulty: 'medium', tableCount: 2, tables: [stadium, concert], primaryTable: 'concert',
        joinEdges: [{ leftTable: 'concert', rightTable: 'stadium', leftColumn: 'stadium_id', rightColumn: 'stadium_id', type: 'fk' }],
        tags: ['join', 'distinct'],
    },
    {
        id: 'spider-concert-capacity-join', suite: 'spider', db: 'concert_singer',
        question: 'For each concert, show the concert name and the capacity of its stadium.',
        goldSQL: 'SELECT c.concert_name, s.capacity FROM concert c JOIN stadium s ON c.stadium_id = s.stadium_id',
        difficulty: 'medium', tableCount: 2, tables: [stadium, concert], primaryTable: 'concert',
        joinEdges: [{ leftTable: 'concert', rightTable: 'stadium', leftColumn: 'stadium_id', rightColumn: 'stadium_id', type: 'fk' }],
        tags: ['join'],
    },
    {
        id: 'spider-singers-in-gala', suite: 'spider', db: 'concert_singer',
        question: "What are the names of singers who performed in the concert named 'Gala'?",
        goldSQL: "SELECT si.name FROM singer si JOIN singer_in_concert sic ON si.singer_id = sic.singer_id JOIN concert c ON sic.concert_id = c.concert_id WHERE c.concert_name = 'Gala'",
        difficulty: 'hard', tableCount: 3, tables: [singer, concert, singerInConcert], primaryTable: 'singer',
        joinEdges: [
            { leftTable: 'singer_in_concert', rightTable: 'singer', leftColumn: 'singer_id', rightColumn: 'singer_id', type: 'fk' },
            { leftTable: 'singer_in_concert', rightTable: 'concert', leftColumn: 'concert_id', rightColumn: 'concert_id', type: 'fk' },
        ],
        tags: ['join', 'multi_join', 'filter'],
    },
    {
        id: 'spider-emp-avg-salary-by-shop', suite: 'spider', db: 'company',
        question: 'What is the average employee salary for each shop name?',
        goldSQL: 'SELECT sh.shop_name, AVG(e.salary) AS avg_salary FROM employee e JOIN shop sh ON e.shop_id = sh.shop_id GROUP BY sh.shop_name',
        difficulty: 'hard', tableCount: 2, tables: [employee, shop], primaryTable: 'employee',
        joinEdges: [{ leftTable: 'employee', rightTable: 'shop', leftColumn: 'shop_id', rightColumn: 'shop_id', type: 'fk' }],
        tags: ['join', 'group_by', 'avg'],
    },
    {
        id: 'spider-customer-most-orders', suite: 'spider', db: 'orders_db',
        question: 'Which customer placed the most orders? Return the customer name.',
        goldSQL: 'SELECT cu.customer_name FROM customer cu JOIN orders o ON cu.customer_id = o.customer_id GROUP BY cu.customer_name ORDER BY COUNT(*) DESC LIMIT 1',
        difficulty: 'hard', tableCount: 2, tables: [customer, orders], primaryTable: 'orders',
        joinEdges: [{ leftTable: 'orders', rightTable: 'customer', leftColumn: 'customer_id', rightColumn: 'customer_id', type: 'fk' }],
        orderMatters: true, tags: ['join', 'group_by', 'order', 'limit'],
    },
    {
        id: 'spider-customer-total-spend', suite: 'spider', db: 'orders_db',
        question: 'What is the total order amount for each customer name?',
        goldSQL: 'SELECT cu.customer_name, SUM(o.amount) AS total FROM customer cu JOIN orders o ON cu.customer_id = o.customer_id GROUP BY cu.customer_name',
        difficulty: 'hard', tableCount: 2, tables: [customer, orders], primaryTable: 'orders',
        joinEdges: [{ leftTable: 'orders', rightTable: 'customer', leftColumn: 'customer_id', rightColumn: 'customer_id', type: 'fk' }],
        tags: ['join', 'group_by', 'sum'],
    },

    // ————— SPIDER 2.0-STYLE: nested subqueries & window functions —————
    {
        id: 'spider2-emp-above-avg', suite: 'spider2', db: 'company',
        question: 'List the names of employees who earn more than the average salary.',
        goldSQL: 'SELECT name FROM employee WHERE salary > (SELECT AVG(salary) FROM employee)',
        difficulty: 'hard', tableCount: 1, tables: [employee], primaryTable: 'employee',
        tags: ['nested', 'subquery'],
    },
    {
        id: 'spider2-product-above-avg-price', suite: 'spider2', db: 'store',
        question: 'Which products have a price above the average product price?',
        goldSQL: 'SELECT product_name FROM product WHERE price > (SELECT AVG(price) FROM product)',
        difficulty: 'hard', tableCount: 1, tables: [product], primaryTable: 'product',
        tags: ['nested', 'subquery'],
    },
    {
        id: 'spider2-sales-running-total', suite: 'spider2', db: 'finance',
        question: 'Show the running total of revenue by month in chronological order.',
        goldSQL: 'SELECT month, SUM(revenue) OVER (ORDER BY month) AS running_total FROM monthly_sales ORDER BY month',
        difficulty: 'extra', tableCount: 1, tables: [monthlySales], primaryTable: 'monthly_sales',
        orderMatters: true, tags: ['window', 'running_total'],
    },
    {
        id: 'spider2-sales-mom-growth', suite: 'spider2', db: 'finance',
        question: 'For each month, show revenue and the change versus the previous month.',
        goldSQL: 'SELECT month, revenue, revenue - LAG(revenue) OVER (ORDER BY month) AS mom_change FROM monthly_sales ORDER BY month',
        difficulty: 'extra', tableCount: 1, tables: [monthlySales], primaryTable: 'monthly_sales',
        orderMatters: true, tags: ['window', 'lag'],
    },
    {
        id: 'spider2-emp-rank-salary', suite: 'spider2', db: 'company',
        question: 'Rank employees by salary within their department (highest = rank 1); show name, department and rank.',
        goldSQL: 'SELECT name, department, RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS salary_rank FROM employee',
        difficulty: 'extra', tableCount: 1, tables: [employee], primaryTable: 'employee',
        tags: ['window', 'partition', 'rank'],
    },
    {
        id: 'spider2-dept-max-earner', suite: 'spider2', db: 'company',
        question: 'For each department, who is the highest-paid employee? Return department and employee name.',
        goldSQL: 'SELECT department, name FROM (SELECT department, name, RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS rk FROM employee) t WHERE rk = 1',
        difficulty: 'extra', tableCount: 1, tables: [employee], primaryTable: 'employee',
        tags: ['window', 'nested', 'partition'],
    },
];

/** Convenience: the mini-database (all tables) a case runs against. */
export function tablesForCase(c: BenchCase): BenchTable[] {
    return c.tables;
}

/** All distinct table names used by any case — for cleanup between runs. */
export function allBenchTableNames(): string[] {
    const set = new Set<string>();
    for (const c of BENCHMARK_CASES) for (const t of c.tables) set.add(t.name);
    return [...set];
}
