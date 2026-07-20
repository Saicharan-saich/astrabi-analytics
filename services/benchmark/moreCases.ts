/**
 * Additional representative case packs: BIRD-style and Internal Sales.
 * ─────────────────────────────────────────────────────────────────────
 * BIRD (Li et al., 2023) emphasises "big, dirty" real-world databases and
 * questions needing external knowledge / numeric reasoning. These cases echo
 * that flavour (ratios, filters + math, value normalization) at small scale.
 *
 * The Internal Sales pack is a star schema close to what the product actually
 * ingests, so it measures the engine on its home turf (the denormalize →
 * single-table path), which is the most decision-relevant number for the app.
 *
 * As with spiderCases, these are self-contained representative cases — not the
 * official BIRD split (which ships GB-scale databases). Use the official
 * importer to run the real split for publication.
 */

import type { BenchCase, BenchTable } from './spiderCases';
import type { JoinEdge } from '../analysisEngine';

// ── BIRD-style database: school funding ──────────────────────────────
const schools: BenchTable = {
    name: 'schools',
    rows: [
        { school_id: 1, school_name: 'Maple High', district: 'North', enrollment: 1200, free_meal_count: 480, funding: 2_400_000 },
        { school_id: 2, school_name: 'Oak Elementary', district: 'North', enrollment: 600, free_meal_count: 390, funding: 1_100_000 },
        { school_id: 3, school_name: 'Pine Middle', district: 'South', enrollment: 900, free_meal_count: 180, funding: 1_800_000 },
        { school_id: 4, school_name: 'Cedar High', district: 'South', enrollment: 1500, free_meal_count: 300, funding: 3_000_000 },
        { school_id: 5, school_name: 'Birch Elementary', district: 'East', enrollment: 400, free_meal_count: 360, funding: 800_000 },
    ],
};

// ── Internal Sales star schema ───────────────────────────────────────
const salesFact: BenchTable = {
    name: 'sales',
    rows: Array.from({ length: 24 }, (_, i) => ({
        sale_id: i + 1,
        product_id: (i % 4) + 1,
        region_id: (i % 3) + 1,
        quantity: 1 + (i % 5),
        revenue: 100 + (i * 37) % 900,
        sale_date: `2024-${String(1 + (i % 6)).padStart(2, '0')}-15`,
    })),
};
const products: BenchTable = {
    name: 'products',
    rows: [
        { product_id: 1, product_name: 'Alpha', category: 'Widgets' },
        { product_id: 2, product_name: 'Beta', category: 'Widgets' },
        { product_id: 3, product_name: 'Gamma', category: 'Gizmos' },
        { product_id: 4, product_name: 'Delta', category: 'Gizmos' },
    ],
};
const regions: BenchTable = {
    name: 'regions',
    rows: [
        { region_id: 1, region_name: 'West' },
        { region_id: 2, region_name: 'Central' },
        { region_id: 3, region_name: 'East' },
    ],
};

const salesJoins: JoinEdge[] = [
    { leftTable: 'sales', rightTable: 'products', leftColumn: 'product_id', rightColumn: 'product_id', type: 'fk' },
    { leftTable: 'sales', rightTable: 'regions', leftColumn: 'region_id', rightColumn: 'region_id', type: 'fk' },
];

export const MORE_CASES: BenchCase[] = [
    // ————— BIRD-style: math + filters + ratios (single-table) —————
    {
        id: 'bird-schools-count-highneed', suite: 'bird', db: 'school_funding',
        question: 'How many schools have more than 350 students on free meals?',
        goldSQL: 'SELECT COUNT(*) AS n FROM schools WHERE free_meal_count > 350',
        difficulty: 'easy', tableCount: 1, tables: [schools], primaryTable: 'schools',
        tags: ['filter', 'count'],
    },
    {
        id: 'bird-schools-highest-funding', suite: 'bird', db: 'school_funding',
        question: 'Which school has the highest funding? Return its name.',
        goldSQL: 'SELECT school_name FROM schools ORDER BY funding DESC LIMIT 1',
        difficulty: 'medium', tableCount: 1, tables: [schools], primaryTable: 'schools',
        orderMatters: true, tags: ['order', 'limit'],
    },
    {
        id: 'bird-schools-funding-per-student', suite: 'bird', db: 'school_funding',
        question: 'What is the total funding per district?',
        goldSQL: 'SELECT district, SUM(funding) AS total_funding FROM schools GROUP BY district',
        difficulty: 'medium', tableCount: 1, tables: [schools], primaryTable: 'schools',
        tags: ['group_by', 'sum'],
    },
    {
        id: 'bird-schools-freemeal-ratio', suite: 'bird', db: 'school_funding',
        question: 'Which school has the highest ratio of free-meal students to enrollment? Return its name.',
        goldSQL: 'SELECT school_name FROM schools ORDER BY CAST(free_meal_count AS DOUBLE) / enrollment DESC LIMIT 1',
        difficulty: 'hard', tableCount: 1, tables: [schools], primaryTable: 'schools',
        orderMatters: true, tags: ['ratio', 'derived', 'order'],
    },
    {
        id: 'bird-schools-avg-enrollment-by-district', suite: 'bird', db: 'school_funding',
        question: 'What is the average enrollment in each district?',
        goldSQL: 'SELECT district, AVG(enrollment) AS avg_enrollment FROM schools GROUP BY district',
        difficulty: 'medium', tableCount: 1, tables: [schools], primaryTable: 'schools',
        tags: ['group_by', 'avg'],
    },

    // ————— Internal Sales: star schema (denormalize → single-table) —————
    {
        id: 'internal-total-revenue', suite: 'internal', db: 'internal_sales',
        question: 'What is the total revenue across all sales?',
        goldSQL: 'SELECT SUM(revenue) AS total FROM sales',
        difficulty: 'easy', tableCount: 1, tables: [salesFact], primaryTable: 'sales',
        tags: ['aggregate', 'sum'],
    },
    {
        id: 'internal-revenue-by-region', suite: 'internal', db: 'internal_sales',
        question: 'What is the total revenue for each region name?',
        goldSQL: 'SELECT r.region_name, SUM(s.revenue) AS revenue FROM sales s JOIN regions r ON s.region_id = r.region_id GROUP BY r.region_name',
        difficulty: 'medium', tableCount: 2, tables: [salesFact, regions], primaryTable: 'sales',
        joinEdges: [{ leftTable: 'sales', rightTable: 'regions', leftColumn: 'region_id', rightColumn: 'region_id', type: 'fk' }],
        tags: ['join', 'group_by', 'sum'],
    },
    {
        id: 'internal-revenue-by-category', suite: 'internal', db: 'internal_sales',
        question: 'What is the total revenue for each product category?',
        goldSQL: 'SELECT p.category, SUM(s.revenue) AS revenue FROM sales s JOIN products p ON s.product_id = p.product_id GROUP BY p.category',
        difficulty: 'medium', tableCount: 2, tables: [salesFact, products], primaryTable: 'sales',
        joinEdges: [{ leftTable: 'sales', rightTable: 'products', leftColumn: 'product_id', rightColumn: 'product_id', type: 'fk' }],
        tags: ['join', 'group_by', 'sum'],
    },
    {
        id: 'internal-top-product', suite: 'internal', db: 'internal_sales',
        question: 'Which product has the highest total revenue? Return the product name.',
        goldSQL: 'SELECT p.product_name FROM sales s JOIN products p ON s.product_id = p.product_id GROUP BY p.product_name ORDER BY SUM(s.revenue) DESC LIMIT 1',
        difficulty: 'hard', tableCount: 2, tables: [salesFact, products], primaryTable: 'sales',
        joinEdges: [{ leftTable: 'sales', rightTable: 'products', leftColumn: 'product_id', rightColumn: 'product_id', type: 'fk' }],
        orderMatters: true, tags: ['join', 'group_by', 'order', 'limit'],
    },
    {
        id: 'internal-revenue-by-product-region', suite: 'internal', db: 'internal_sales',
        question: 'What is the total revenue for each product category in each region?',
        goldSQL: 'SELECT p.category, r.region_name, SUM(s.revenue) AS revenue FROM sales s JOIN products p ON s.product_id = p.product_id JOIN regions r ON s.region_id = r.region_id GROUP BY p.category, r.region_name',
        difficulty: 'extra', tableCount: 3, tables: [salesFact, products, regions], primaryTable: 'sales',
        joinEdges: salesJoins, tags: ['join', 'multi_join', 'group_by'],
    },
    {
        id: 'internal-avg-order-value', suite: 'internal', db: 'internal_sales',
        question: 'What is the average revenue per sale?',
        goldSQL: 'SELECT AVG(revenue) AS avg_revenue FROM sales',
        difficulty: 'easy', tableCount: 1, tables: [salesFact], primaryTable: 'sales',
        tags: ['aggregate', 'avg'],
    },
];
