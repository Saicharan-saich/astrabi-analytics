/**
 * Plans, trials and card payments.
 *
 * Plans and limits come from backend/plans.json (the same file the website
 * reads). Payments go through Stripe Checkout and the Stripe billing portal,
 * called over Stripe's REST API; webhooks are verified with the signing
 * secret before anything is changed.
 *
 * Server settings:
 *   STRIPE_SECRET_KEY        sk_test_… while testing, sk_live_… to take money
 *   STRIPE_WEBHOOK_SECRET    whsec_… from the webhook endpoint in Stripe
 *   STRIPE_PRICE_SOLO / STRIPE_PRICE_TEAM   the price IDs for each paid plan
 *   BILLING_ENFORCED=true    apply plan limits (off: everyone keeps today's
 *                            limit, so nothing changes until you switch it on)
 */
const crypto = require('crypto');

function loadPlans() {
    // The backend is deployed on its own, so the canonical copy lives beside this file
    // (the website imports the same file).
    try {
        const plans = require('./plans.json');
        return JSON.parse(JSON.stringify(plans));
    } catch {
        return { currency: 'GBP', trialDays: 14, trialPlan: 'solo', plans: [{ id: 'free', name: 'Free', aiQuestionsPerDay: 5, seats: 1 }] };
    }
}

const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** The limit and plan someone has right now, from their subscription row. */
function effectivePlan(config, row, now = Date.now()) {
    const byId = (id) => config.plans.find(p => p.id === id) || config.plans[0];
    if (!row) return { plan: byId('free'), status: 'none' };
    if (row.status === 'trial') {
        const ends = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
        return ends > now ? { plan: byId(row.plan), status: 'trial', trialEndsAt: new Date(ends).toISOString() } : { plan: byId('free'), status: 'trial_ended' };
    }
    if (PAID_STATUSES.has(row.status)) return { plan: byId(row.plan), status: row.status, periodEnd: row.current_period_end || null };
    return { plan: byId('free'), status: row.status || 'none' };
}

/** Stripe's signature check: t=…,v1=… over "t.payload" with the endpoint secret, within 5 minutes. */
function verifyStripeSignature(payload, header, secret, toleranceSeconds = 300, now = Date.now()) {
    if (!header || !secret) return false;
    const parts = Object.fromEntries(String(header).split(',').map(kv => kv.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
    const signatures = String(header).split(',').filter(kv => kv.trim().startsWith('v1=')).map(kv => kv.trim().slice(3));
    const timestamp = Number(parts.t);
    if (!timestamp || !signatures.length) return false;
    if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    return signatures.some(sig => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}

/** application/x-www-form-urlencoded with Stripe's bracket notation for nested fields. */
function stripeForm(object, prefix = '') {
    const pairs = [];
    for (const [key, value] of Object.entries(object)) {
        if (value === undefined || value === null) continue;
        const name = prefix ? `${prefix}[${key}]` : key;
        if (Array.isArray(value)) value.forEach((item, i) => typeof item === 'object' ? pairs.push(stripeForm(item, `${name}[${i}]`)) : pairs.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(item)}`));
        else if (typeof value === 'object') pairs.push(stripeForm(value, name));
        else pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
    return pairs.filter(Boolean).join('&');
}

function createBillingService({ getPool, appUrl, env = process.env, fetchImpl = (...args) => fetch(...args) }) {
    const config = loadPlans();
    const stripeEnabled = () => Boolean(env.STRIPE_SECRET_KEY);
    const enforced = () => /^(1|true|yes|on)$/i.test(String(env.BILLING_ENFORCED || ''));
    const priceFor = (planId) => { const plan = config.plans.find(p => p.id === planId); return plan?.stripePriceEnv ? env[plan.stripePriceEnv] : undefined; };
    const planForPrice = (priceId) => config.plans.find(p => p.stripePriceEnv && env[p.stripePriceEnv] === priceId)?.id;

    async function stripe(method, endpoint, body) {
        const response = await fetchImpl(`https://api.stripe.com/v1/${endpoint}`, {
            method,
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body ? stripeForm(body) : undefined,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error?.message || `Stripe ${endpoint} failed (${response.status})`);
        return data;
    }

    async function ensureTables() {
        const pool = getPool();
        if (!pool) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                plan TEXT NOT NULL DEFAULT 'free',
                status TEXT NOT NULL DEFAULT 'none',
                stripe_customer_id TEXT,
                stripe_subscription_id TEXT,
                trial_ends_at TIMESTAMPTZ,
                current_period_end TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        try { await pool.query('CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions (stripe_customer_id)'); } catch { /* exists */ }
        try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_limit_override INTEGER'); } catch { /* exists */ }
    }

    /** Everyone starts with a free trial of the paid plan, no card needed. */
    async function subscriptionFor(userId) {
        const pool = getPool();
        const { rows } = await pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
        if (rows[0]) return rows[0];
        const created = await pool.query(
            `INSERT INTO subscriptions (user_id, plan, status, trial_ends_at) VALUES ($1, $2, 'trial', NOW() + ($3 || ' days')::interval)
             ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING *`,
            [userId, config.trialPlan || 'solo', String(config.trialDays || 14)],
        );
        return created.rows[0];
    }

    /** The AI question limit for today. Null = no limit (admins). */
    async function aiLimitFor(user) {
        if (user.role === 'admin') return null;
        if (Number.isInteger(user.ai_limit_override)) return user.ai_limit_override;
        if (!enforced()) return user.daily_ai_limit || 50;
        const current = effectivePlan(config, await subscriptionFor(user.id));
        return current.plan.aiQuestionsPerDay;
    }

    async function status(userId) {
        const pool = getPool();
        const row = await subscriptionFor(userId);
        const current = effectivePlan(config, row);
        const { rows } = await pool.query('SELECT id, role, daily_ai_limit, ai_limit_override FROM users WHERE id = $1', [userId]);
        const limit = rows[0] ? await aiLimitFor(rows[0]) : current.plan.aiQuestionsPerDay;
        const used = await pool.query(`SELECT COUNT(*)::int AS n FROM usage_logs WHERE user_id = $1 AND action = 'ai_query' AND created_at >= CURRENT_DATE`, [userId]);
        return {
            plan: { id: current.plan.id, name: current.plan.name },
            status: current.status,
            trialEndsAt: current.trialEndsAt || null,
            periodEnd: current.periodEnd || null,
            hasBillingAccount: Boolean(row.stripe_customer_id),
            aiQuestions: { usedToday: used.rows[0].n, limit },
            paymentsEnabled: stripeEnabled(),
            limitsEnforced: enforced(),
        };
    }

    async function checkout(user, planId) {
        if (!stripeEnabled()) return { ok: false, status: 503, error: 'Card payments are not switched on yet.' };
        const price = priceFor(planId);
        if (!price) return { ok: false, status: 400, error: 'That plan cannot be bought yet.' };
        const row = await subscriptionFor(user.userId);
        const base = appUrl().replace(/\/$/, '');
        const session = await stripe('POST', 'checkout/sessions', {
            mode: 'subscription',
            line_items: [{ price, quantity: 1 }],
            success_url: `${base}/?billing=success`,
            cancel_url: `${base}/?billing=cancelled`,
            client_reference_id: user.userId,
            ...(row.stripe_customer_id ? { customer: row.stripe_customer_id } : { customer_email: user.email }),
            subscription_data: { metadata: { user_id: user.userId, plan: planId } },
            metadata: { user_id: user.userId, plan: planId },
            allow_promotion_codes: 'true',
            billing_address_collection: 'auto',
        });
        return { ok: true, url: session.url };
    }

    async function portal(user) {
        if (!stripeEnabled()) return { ok: false, status: 503, error: 'Card payments are not switched on yet.' };
        const row = await subscriptionFor(user.userId);
        if (!row.stripe_customer_id) return { ok: false, status: 400, error: 'There is no billing account yet. Choose a plan first.' };
        const session = await stripe('POST', 'billing_portal/sessions', { customer: row.stripe_customer_id, return_url: `${appUrl().replace(/\/$/, '')}/?billing=portal` });
        return { ok: true, url: session.url };
    }

    /** Apply one verified Stripe event. Unknown events are ignored. */
    async function handleEvent(event) {
        const pool = getPool();
        const object = event?.data?.object || {};
        const save = async (userId, fields) => {
            if (!userId) return false;
            await subscriptionFor(userId);
            const keys = Object.keys(fields);
            await pool.query(
                `UPDATE subscriptions SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE user_id = $1`,
                [userId, ...keys.map(k => fields[k])],
            );
            return true;
        };
        const userForCustomer = async (customer) => (await pool.query('SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1', [customer])).rows[0]?.user_id;
        switch (event?.type) {
            case 'checkout.session.completed': {
                const userId = object.client_reference_id || object.metadata?.user_id;
                return save(userId, { stripe_customer_id: object.customer, stripe_subscription_id: object.subscription, plan: object.metadata?.plan || 'solo', status: 'active' });
            }
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted': {
                const userId = object.metadata?.user_id || await userForCustomer(object.customer);
                const price = object.items?.data?.[0]?.price?.id;
                const deleted = event.type === 'customer.subscription.deleted';
                return save(userId, {
                    stripe_customer_id: object.customer,
                    stripe_subscription_id: object.id,
                    plan: deleted ? 'free' : (planForPrice(price) || object.metadata?.plan || 'solo'),
                    status: deleted ? 'canceled' : object.status,
                    current_period_end: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null,
                });
            }
            case 'invoice.payment_failed': {
                const userId = await userForCustomer(object.customer);
                return save(userId, { status: 'past_due' });
            }
            default:
                return false;
        }
    }

    return { config, ensureTables, subscriptionFor, aiLimitFor, status, checkout, portal, handleEvent, stripeEnabled, enforced };
}

function registerBillingRoutes(app, express, service, { requireUser }) {
    // Raw body: the signature is over the exact bytes Stripe sent. Registered before express.json().
    app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
        const payload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
        if (!verifyStripeSignature(payload, req.get('Stripe-Signature'), process.env.STRIPE_WEBHOOK_SECRET)) {
            return res.status(400).json({ received: false, error: 'Signature check failed' });
        }
        try {
            await service.handleEvent(JSON.parse(payload));
            res.json({ received: true });
        } catch (error) {
            console.error('[Billing] Webhook failed:', error.message);
            res.status(500).json({ received: false });
        }
    });

    return function registerAuthenticated() {
        app.get('/api/billing/plans', (_req, res) => res.json({ success: true, ...service.config, paymentsEnabled: service.stripeEnabled() }));
        app.get('/api/billing/status', requireUser, async (req, res) => {
            try { res.json({ success: true, ...(await service.status(req.authUser.userId)) }); }
            catch (error) { console.error('[Billing] Status failed:', error.message); res.status(500).json({ success: false, error: 'Could not read your plan' }); }
        });
        for (const [route, action] of [['/api/billing/checkout', 'checkout'], ['/api/billing/portal', 'portal']]) {
            app.post(route, requireUser, async (req, res) => {
                try {
                    const result = action === 'checkout' ? await service.checkout(req.authUser, String(req.body?.plan || '')) : await service.portal(req.authUser);
                    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });
                    res.json({ success: true, url: result.url });
                } catch (error) {
                    console.error(`[Billing] ${action} failed:`, error.message);
                    res.status(502).json({ success: false, error: 'The payment page could not be opened. Please try again.' });
                }
            });
        }
    };
}

module.exports = { createBillingService, registerBillingRoutes, verifyStripeSignature, effectivePlan, stripeForm, loadPlans };
