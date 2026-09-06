'use strict';

const privacy = import('./dashboardPrivacy.mjs');

// The ownership predicate is part of the atomic UPSERT: a preflight SELECT
// alone would leave a race between checking and saving.
const SAVE_DASHBOARD_SQL = `
    INSERT INTO dashboards (id, user_id, name, dataset_id, items, layout, filters, formatting, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, dataset_id = EXCLUDED.dataset_id,
        items = EXCLUDED.items, layout = EXCLUDED.layout,
        filters = EXCLUDED.filters, formatting = EXCLUDED.formatting,
        updated_at = NOW()
    WHERE dashboards.user_id = EXCLUDED.user_id
    RETURNING id
`;

async function saveDashboard(pool, userId, input) {
    const { sanitizeDashboard } = await privacy;
    const clean = sanitizeDashboard(input);
    if (typeof clean.id !== 'string' || !clean.id.trim() || clean.id.length > 256) {
        return { status: 400, body: { error: 'A dashboard ID of 1–256 characters is required' } };
    }
    const result = await pool.query(SAVE_DASHBOARD_SQL, [
        clean.id, userId, clean.name || 'My Dashboard', clean.dataset_id || null,
        JSON.stringify(clean.items), JSON.stringify(clean.layout || null),
        JSON.stringify(clean.filters || []), JSON.stringify(clean.formatting || {}),
    ]);
    if (!result.rowCount) return { status: 409, body: { error: 'Dashboard ID is unavailable' } };
    return { status: 200, body: { success: true, id: clean.id } };
}

async function sanitizeStoredDashboards(rows) {
    const { sanitizeDashboard } = await privacy;
    return rows.map(row => sanitizeDashboard({
        ...row,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    }));
}

// Scrub historical cached results without deleting dashboard definitions.
// Run before accepting requests; use bounded batches and preserve updated_at.
async function scrubStoredDashboardResults(pool) {
    const { sanitizeDashboard } = await privacy;
    let afterId = '';
    for (;;) {
        const { rows } = await pool.query(
            'SELECT id, user_id, items, layout, filters, formatting FROM dashboards WHERE id > $1 ORDER BY id LIMIT 100',
            [afterId],
        );
        if (!rows.length) break;
        for (const row of rows) {
            const clean = sanitizeDashboard(row);
            if (['items', 'layout', 'filters', 'formatting'].every(key =>
                JSON.stringify(clean[key]) === JSON.stringify(row[key]))) continue;
            await pool.query(
                'UPDATE dashboards SET items=$1, layout=$2, filters=$3, formatting=$4 WHERE id=$5 AND user_id=$6',
                [JSON.stringify(clean.items), JSON.stringify(clean.layout || null),
                    JSON.stringify(clean.filters || []), JSON.stringify(clean.formatting || {}), row.id, row.user_id],
            );
        }
        afterId = rows[rows.length - 1].id;
    }
}

module.exports = { saveDashboard, sanitizeStoredDashboards, scrubStoredDashboardResults, SAVE_DASHBOARD_SQL };
