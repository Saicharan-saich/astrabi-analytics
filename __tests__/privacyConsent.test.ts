import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { collectSafeDomains } from '../services/ai-sql/schemaSerializer';
import { buildPrivacyDisclosure, ALWAYS_SENT, NEVER_SENT } from '../services/ai-sql/privacyDisclosure';

// The consent module talks to localStorage; these tests run in node.
beforeAll(() => {
    if (typeof globalThis.localStorage === 'undefined') {
        const store = new Map<string, string>();
        (globalThis as any).localStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, String(v)),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        };
    }
});

// Imported after the stub exists, since the module reads storage on call only.
const {
    getPrivacyMode, setPrivacyMode, getEffectivePrivacyMode,
    hasEnhancedConsent, grantEnhancedConsent, revokeEnhancedConsent,
    DISCLOSURE_VERSION,
} = await import('../services/ai-sql/privacyMode');

const NAMES = ['Alice Brown', 'Ben Clark', 'Cara Doyle', 'Dan Evans', 'Eve Foster'];
const REGIONS = ['North', 'South', 'East'];
const PRODUCTS = ['Coffee', 'Tea', 'Juice'];
const CHANNELS = ['Online', 'In-store', 'Delivery'];
const DIAGNOSES = ['Asthma', 'Diabetes'];
// Deliberately low-cardinality so the cardinality guard does NOT fire — the
// value-shape check has to be what catches this column.
const NOTES = ['bob@example.com', 'carol@example.com', 'dave@example.com', 'erin@example.com'];

const ROWS = Array.from({ length: 18 }, (_, i) => ({
    OrderID: 1000 + i,
    OrderDate: `2025-0${1 + (i % 6)}-1${i % 10}`,
    CustomerName: NAMES[i % NAMES.length],
    CustomerEmail: `${NAMES[i % NAMES.length].split(' ')[0].toLowerCase()}@example.com`,
    Region: REGIONS[i % REGIONS.length],
    Product: PRODUCTS[i % PRODUCTS.length],
    Channel: CHANNELS[i % CHANNELS.length],
    Diagnosis: DIAGNOSES[i % DIAGNOSES.length],
    Notes: NOTES[i % NOTES.length],
    Salary: 30000 + i * 1000,
    Quantity: 1 + (i % 5),
    TotalPrice: Math.round((2 + i * 0.7) * 100) / 100,
}));

function build() {
    const etl = runETLPipeline(ROWS, 'orders.csv');
    return {
        rows: etl.rows,
        model: buildSemanticModel({
            id: 't', name: 'orders', rows: etl.rows, columns: etl.columns,
            totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext,
        } as any),
    };
}

describe('privacy disclosure', () => {
    // The guarantee that matters: the dialog cannot under-report. If this ever
    // fails, the consent screen is showing the user less than actually leaves.
    it('reports exactly what the pipeline would send — never less', () => {
        const { rows, model } = build();
        const domains = collectSafeDomains(rows, model);
        const disclosure = buildPrivacyDisclosure(rows, model);

        expect(disclosure.shared.map(c => c.name).sort()).toEqual([...domains.keys()].sort());
        for (const col of disclosure.shared) {
            expect(domains.get(col.name)!.values, `values for ${col.name}`).toEqual(col.values);
        }
    });

    it('accounts for every column exactly once', () => {
        const { rows, model } = build();
        const d = buildPrivacyDisclosure(rows, model);
        const named = [...d.shared.map(c => c.name), ...d.withheld.map(c => c.name)];
        expect(named.sort()).toEqual(model.fields.map(f => f.name).sort());
        expect(new Set(named).size).toBe(named.length);
    });

    it('never shares personal, identifying or sensitive columns', () => {
        const { rows, model } = build();
        const shared = buildPrivacyDisclosure(rows, model).shared.map(c => c.name);
        for (const forbidden of ['customer_name', 'customer_email', 'order_id', 'diagnosis', 'salary', 'notes']) {
            expect(shared, `${forbidden} must never be shared`).not.toContain(forbidden);
        }
    });

    it('catches a personal column whose name gives nothing away', () => {
        const { rows, model } = build();
        // "notes" holds email addresses and is low-cardinality, so the name
        // rules and the cardinality guard both pass it. Value shape must not.
        const notes = buildPrivacyDisclosure(rows, model).withheld.find(c => c.name === 'notes');
        expect(notes, 'notes should be withheld').toBeDefined();
        expect(notes!.reason).toBe('value-shape');
    });

    it('does share ordinary low-cardinality categories', () => {
        const { rows, model } = build();
        const shared = buildPrivacyDisclosure(rows, model).shared.map(c => c.name);
        expect(shared).toContain('product');
        expect(shared).toContain('region');
        expect(shared).toContain('channel');
    });

    it('shows the real values, so consent is informed', () => {
        const { rows, model } = build();
        const product = buildPrivacyDisclosure(rows, model).shared.find(c => c.name === 'product');
        expect(product!.values.sort()).toEqual(['Coffee', 'Juice', 'Tea']);
        expect(product!.truncated).toBe(false);
    });

    it('gives every withheld column a plain-English reason', () => {
        const { rows, model } = build();
        for (const col of buildPrivacyDisclosure(rows, model).withheld) {
            expect(col.explanation, col.name).toBeTruthy();
            expect(col.explanation.length, col.name).toBeGreaterThan(10);
        }
    });

    it('counts the values it would send', () => {
        const { rows, model } = build();
        const d = buildPrivacyDisclosure(rows, model);
        expect(d.totalValuesShared).toBe(d.shared.reduce((n, c) => n + c.values.length, 0));
        expect(d.totalValuesShared).toBeGreaterThan(0);
    });

    it('states the rules for both modes', () => {
        expect(ALWAYS_SENT.length).toBeGreaterThan(3);
        expect(NEVER_SENT.length).toBeGreaterThan(3);
        expect(NEVER_SENT.join(' ').toLowerCase()).toContain('row');
    });
});

describe('enhanced-mode consent', () => {
    beforeEach(() => localStorage.clear());

    it('is not granted by default', () => {
        expect(hasEnhancedConsent()).toBe(false);
    });

    // The core guarantee: preferring enhanced is not the same as agreeing to it.
    it('keeps the effective mode strict until the user agrees', () => {
        setPrivacyMode('enhanced');
        expect(getPrivacyMode()).toBe('enhanced');
        expect(getEffectivePrivacyMode()).toBe('strict');

        grantEnhancedConsent();
        expect(getEffectivePrivacyMode()).toBe('enhanced');
    });

    it('falls back to strict when consent is withdrawn', () => {
        setPrivacyMode('enhanced');
        grantEnhancedConsent();
        expect(getEffectivePrivacyMode()).toBe('enhanced');

        revokeEnhancedConsent();
        expect(getEffectivePrivacyMode()).toBe('strict');
    });

    it('ignores consent recorded against an older disclosure', () => {
        setPrivacyMode('enhanced');
        localStorage.setItem('qi_ai_enhanced_consent', JSON.stringify({
            version: DISCLOSURE_VERSION - 1, grantedAt: new Date().toISOString(),
        }));
        expect(hasEnhancedConsent()).toBe(false);
        expect(getEffectivePrivacyMode()).toBe('strict');
    });

    it('ignores corrupt stored consent', () => {
        setPrivacyMode('enhanced');
        localStorage.setItem('qi_ai_enhanced_consent', 'not json');
        expect(hasEnhancedConsent()).toBe(false);
        expect(getEffectivePrivacyMode()).toBe('strict');
    });

    it('never reports enhanced while the preference is strict, consent or not', () => {
        setPrivacyMode('strict');
        grantEnhancedConsent();
        expect(getEffectivePrivacyMode()).toBe('strict');
    });

    it('records when consent was given', () => {
        grantEnhancedConsent();
        const raw = JSON.parse(localStorage.getItem('qi_ai_enhanced_consent')!);
        expect(raw.version).toBe(DISCLOSURE_VERSION);
        expect(Date.parse(raw.grantedAt)).not.toBeNaN();
    });
});

const {
    applySelection, countSharedValues, toggleColumn, toggleValue, excludeAll,
    getSelection, setSelection, clearSelection, EMPTY_SELECTION,
} = await import('../services/ai-sql/privacySelection');

type D = Map<string, { values: string[]; total: number }>;
const domains = (): D => new Map([
    ['product', { values: ['Coffee', 'Tea', 'Juice'], total: 3 }],
    ['region', { values: ['North', 'South'], total: 2 }],
]);

describe('per-column and per-value sharing choices', () => {
    beforeEach(() => localStorage.clear());

    it('sends everything eligible when nothing is switched off', () => {
        expect(countSharedValues(domains(), EMPTY_SELECTION)).toBe(5);
    });

    it('drops a whole column that was switched off', () => {
        const sel = toggleColumn(EMPTY_SELECTION, 'region');
        const out = applySelection(domains(), sel);
        expect([...out.keys()]).toEqual(['product']);
        expect(countSharedValues(domains(), sel)).toBe(3);
    });

    it('drops individual values that were switched off', () => {
        let sel = toggleValue(EMPTY_SELECTION, 'product', 'Tea');
        sel = toggleValue(sel, 'product', 'Juice');
        const out = applySelection(domains(), sel);
        expect(out.get('product')!.values).toEqual(['Coffee']);
        expect(out.get('region')!.values).toEqual(['North', 'South']);
        expect(countSharedValues(domains(), sel)).toBe(3);
    });

    it('drops a column entirely when every one of its values is switched off', () => {
        let sel = EMPTY_SELECTION;
        for (const v of ['North', 'South']) sel = toggleValue(sel, 'region', v);
        expect(applySelection(domains(), sel).has('region')).toBe(false);
    });

    it('sends nothing at all after "switch all off"', () => {
        const sel = excludeAll(['product', 'region']);
        expect(applySelection(domains(), sel).size).toBe(0);
        expect(countSharedValues(domains(), sel)).toBe(0);
    });

    // The one-directional guarantee: a choice can only ever remove.
    it('can never add a column the automatic filter rejected', () => {
        const tampered = {
            excludedColumns: [],
            excludedValues: { customer_email: ['a@b.com'] },
        };
        const out = applySelection(domains(), tampered);
        expect(out.has('customer_email')).toBe(false);
        expect([...out.keys()].sort()).toEqual(['product', 'region']);
    });

    it('never invents a value that was not in the eligible set', () => {
        const out = applySelection(domains(), EMPTY_SELECTION);
        for (const [col, d] of out) {
            expect(d.values.every(v => domains().get(col)!.values.includes(v))).toBe(true);
        }
    });

    it('toggling twice returns to sharing', () => {
        const off = toggleColumn(EMPTY_SELECTION, 'product');
        const back = toggleColumn(off, 'product');
        expect(applySelection(domains(), back).size).toBe(2);
    });

    it('remembers choices per dataset', () => {
        setSelection('sales.csv', toggleColumn(EMPTY_SELECTION, 'region'));
        expect(getSelection('sales.csv').excludedColumns).toEqual(['region']);
        // A different file starts clean.
        expect(getSelection('other.csv').excludedColumns).toEqual([]);
    });

    it('survives corrupt stored choices by sharing nothing extra', () => {
        localStorage.setItem('qi_ai_privacy_selection:sales.csv', '{{{ not json');
        expect(getSelection('sales.csv')).toEqual(EMPTY_SELECTION);
    });

    it('can be cleared', () => {
        setSelection('sales.csv', excludeAll(['product']));
        clearSelection('sales.csv');
        expect(getSelection('sales.csv').excludedColumns).toEqual([]);
    });
});
