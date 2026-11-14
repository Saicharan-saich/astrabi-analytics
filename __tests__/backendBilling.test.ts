/**
 * Plans, trials and Stripe payments on the backend, with an in-memory
 * stand-in for the database and a recorded stand-in for Stripe.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';

const { createBillingService, verifyStripeSignature, effectivePlan, stripeForm, loadPlans } = require('../backend/billing.js');

function fakeDb() {
    const subs = new Map<string, any>();
    const usage: { user_id: string; action: string }[] = [];
    const pool = {
        query: async (sql: string, params: any[] = []) => {
            const s = sql.replace(/\s+/g, ' ').trim();
            if (/^SELECT \* FROM subscriptions WHERE user_id/.test(s)) return { rows: subs.has(params[0]) ? [subs.get(params[0])] : [] };
            if (/^INSERT INTO subscriptions/.test(s)) {
                const row = { user_id: params[0], plan: params[1], status: 'trial', trial_ends_at: new Date(Date.now() + Number(params[2]) * 86400000).toISOString(), stripe_customer_id: null };
                subs.set(params[0], row);
                return { rows: [row] };
            }
            if (/^UPDATE subscriptions SET/.test(s)) {
                const keys = [...s.matchAll(/(\w+) = \$(\d+)/g)].map(m => [m[1], Number(m[2])] as const);
                const row = subs.get(params[0]);
                for (const [key, index] of keys) row[key] = params[index - 1];
                return { rows: [] };
            }
            if (/^SELECT user_id FROM subscriptions WHERE stripe_customer_id/.test(s)) return { rows: [...subs.values()].filter(r => r.stripe_customer_id === params[0]) };
            if (/^SELECT id, role, daily_ai_limit, ai_limit_override FROM users/.test(s)) return { rows: [{ id: params[0], role: 'contributor', daily_ai_limit: 50, ai_limit_override: null }] };
            if (/^SELECT COUNT\(\*\)::int AS n FROM usage_logs/.test(s)) return { rows: [{ n: usage.filter(u => u.user_id === params[0]).length }] };
            throw new Error(`unexpected query: ${s}`);
        },
    };
    return { pool, subs, usage };
}

const env = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_SOLO: 'price_solo', STRIPE_PRICE_TEAM: 'price_team', BILLING_ENFORCED: 'true' } as Record<string, string>;
let db: ReturnType<typeof fakeDb>;
let calls: { url: string; body: string }[];
let billing: any;
beforeEach(() => {
    db = fakeDb();
    calls = [];
    const fetchImpl = async (url: string, init: any) => { calls.push({ url, body: init.body }); return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) }; };
    billing = createBillingService({ getPool: () => db.pool, appUrl: () => 'https://quickinsight.co.uk', env, fetchImpl });
});

describe('plans', () => {
    it('come from one file the website also reads, with a trial of the paid plan', () => {
        const plans = loadPlans();
        expect(plans.plans.map((p: any) => p.id)).toEqual(['free', 'solo', 'team']);
        expect(plans.trialDays).toBe(14);
    });

    it('a new account gets a 14-day trial; after it ends, the free limits apply', () => {
        const config = loadPlans();
        const now = Date.now();
        expect(effectivePlan(config, { status: 'trial', plan: 'solo', trial_ends_at: new Date(now + 86400000).toISOString() }, now).plan.id).toBe('solo');
        expect(effectivePlan(config, { status: 'trial', plan: 'solo', trial_ends_at: new Date(now - 1000).toISOString() }, now)).toMatchObject({ status: 'trial_ended', plan: { id: 'free' } });
        expect(effectivePlan(config, { status: 'active', plan: 'team' }, now).plan.aiQuestionsPerDay).toBe(150);
        expect(effectivePlan(config, { status: 'canceled', plan: 'team' }, now).plan.id).toBe('free');
    });

    it('limit AI questions by plan only once billing is switched on', async () => {
        expect(await billing.aiLimitFor({ id: 'u1', role: 'contributor', daily_ai_limit: 50 })).toBe(50); // trial of Solo
        expect(await billing.aiLimitFor({ id: 'a1', role: 'admin' })).toBeNull();
        expect(await billing.aiLimitFor({ id: 'u2', role: 'contributor', ai_limit_override: 7 })).toBe(7);
        const off = createBillingService({ getPool: () => db.pool, appUrl: () => 'x', env: { ...env, BILLING_ENFORCED: '' } });
        expect(await off.aiLimitFor({ id: 'u3', role: 'contributor', daily_ai_limit: 50 })).toBe(50);
        db.subs.set('u4', { user_id: 'u4', plan: 'solo', status: 'trial', trial_ends_at: new Date(Date.now() - 1000).toISOString() });
        expect(await billing.aiLimitFor({ id: 'u4', role: 'contributor', daily_ai_limit: 50 })).toBe(5);
        expect(await off.aiLimitFor({ id: 'u4', role: 'contributor', daily_ai_limit: 50 })).toBe(50);
    });
});

describe('Stripe', () => {
    it('opens Checkout for the chosen plan, tied to the account', async () => {
        const result = await billing.checkout({ userId: 'u1', email: 'owner@shop.co.uk' }, 'solo');
        expect(result).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
        expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
        const body = decodeURIComponent(calls[0].body);
        expect(body).toContain('mode=subscription');
        expect(body).toContain('line_items[0][price]=price_solo');
        expect(body).toContain('client_reference_id=u1');
        expect(body).toContain('customer_email=owner@shop.co.uk');
        expect(body).toContain('success_url=https://quickinsight.co.uk/?billing=success');
        expect(await billing.checkout({ userId: 'u1' }, 'free')).toMatchObject({ ok: false });
        const noStripe = createBillingService({ getPool: () => db.pool, appUrl: () => 'x', env: {} });
        expect(await noStripe.checkout({ userId: 'u1' }, 'solo')).toMatchObject({ ok: false, status: 503 });
    });

    it('accepts only webhooks signed with the endpoint secret, within five minutes', () => {
        const payload = JSON.stringify({ type: 'checkout.session.completed' });
        const t = Math.floor(Date.now() / 1000);
        const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
        expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'whsec_test')).toBe(true);
        expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'whsec_other')).toBe(false);
        expect(verifyStripeSignature(`${payload} `, `t=${t},v1=${sig}`, 'whsec_test')).toBe(false);
        expect(verifyStripeSignature(payload, `t=${t - 600},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t - 600}.${payload}`).digest('hex')}`, 'whsec_test')).toBe(false);
        expect(verifyStripeSignature(payload, undefined, 'whsec_test')).toBe(false);
    });

    it('turns payment events into the account’s plan', async () => {
        await billing.handleEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'u1', customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'team' } } } });
        expect(db.subs.get('u1')).toMatchObject({ plan: 'team', status: 'active', stripe_customer_id: 'cus_1' });
        await billing.handleEvent({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
        expect(db.subs.get('u1').status).toBe('past_due');
        await billing.handleEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 1800000000, items: { data: [{ price: { id: 'price_solo' } }] } } } });
        expect(db.subs.get('u1')).toMatchObject({ plan: 'solo', status: 'active' });
        await billing.handleEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
        expect(db.subs.get('u1')).toMatchObject({ plan: 'free', status: 'canceled' });
        expect(await billing.handleEvent({ type: 'something.else', data: { object: {} } })).toBe(false);
    });

    it('encodes nested fields the way Stripe expects', () => {
        expect(decodeURIComponent(stripeForm({ a: 1, line_items: [{ price: 'p', quantity: 1 }], meta: { k: 'v' } }))).toBe('a=1&line_items[0][price]=p&line_items[0][quantity]=1&meta[k]=v');
    });
});
