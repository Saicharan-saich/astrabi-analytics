/**
 * What each column means, end to end: the cleaner, the semantic layer, the
 * data shape and the labels people read must agree. Two values are not
 * enough to be yes/no — Male/Female, North/South, Pass/Fail keep their words.
 */
import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';
import { runETLPipeline } from '../services/etlPipeline';
import { resolveAISQLSemanticModel } from '../services/ai-sql/semanticLayer';
import { describeDatasetShape } from '../services/datasetShape';
import { relabelYesNo } from '../services/ai-sql/plainLabels';
import { reconcileRolesWithData } from '../services/aiSemanticProfiler';
import { buildDataStory } from '../services/dataStory';
import { isLabelName, isYesNoValues, repairTwoLabelColumns } from '../utils/twoValues';
import { isAdditiveName, isPerRowName } from '../utils/numberMeaning';

const N = 300;
const pick = <T,>(list: T[], i: number) => list[i % list.length];
const ROWS = Array.from({ length: N }, (_, i) => ({
    order_id: 100000 + i, customer_id: 5000 + (i % 120),
    gender: pick(['Male', 'Female', 'Female'], i), sex: pick(['M', 'F', 'F'], i), area: pick(['Urban', 'Rural'], i),
    result: pick(['Pass', 'Pass', 'Fail'], i), status: pick(['Active', 'Inactive'], i), region: pick(['North', 'South'], i),
    plan: pick(['Basic', 'Premium'], i), shift: pick(['Day', 'Night'], i), gender_code: pick([0, 1], i),
    smoker: pick(['No', 'No', 'Yes'], i), active_yn: pick(['Y', 'N'], i), is_member: pick(['T', 'F'], i), churn: pick([0, 0, 0, 1], i),
    paid: i % 3 > 0, has_kids: pick(['TRUE', 'FALSE'], i), covid: pick([0, 1, 0, 0], i), casino: pick(['Bellagio', 'Wynn', 'Aria'], i),
    rating: 1 + (i % 5), year: 2020 + (i % 5), latitude: 51 + (i % 50) / 100, longitude: -0.1 + (i % 40) / 100,
    order_date: `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    revenue: Math.round((50 + (i * 37.7) % 900) * 100) / 100, unit_price: 9.99 + (i % 13), quantity: 1 + (i % 7),
    discount_pct: (i % 30) / 100, temperature: 10 + (i * 1.3) % 25, age: 18 + (i * 7) % 60,
}));

function load(): { ds: Dataset; type: (name: string) => ColumnType | undefined; semantic: (name: string) => string | undefined } {
    const etl = runETLPipeline(ROWS, 'mixed.csv');
    const ds = { id: 'm', name: 'mixed.csv', rows: etl.rows, columns: etl.columns, totalRows: etl.rows.length } as unknown as Dataset;
    const { model } = resolveAISQLSemanticModel(ds);
    return {
        ds,
        type: name => etl.columns.find(c => c.name === name)?.type,
        semantic: name => model.fields.find(f => f.name === name)?.semanticType,
    };
}

describe('the one yes/no rule', () => {
    it('needs a true/false pair, not just two values', () => {
        expect(isYesNoValues(['Yes', 'No'])).toBe(true);
        expect(isYesNoValues(['Y', 'N', ''])).toBe(true);
        expect(isYesNoValues([true, false])).toBe(true);
        expect(isYesNoValues([0, 1, 1], 'churn')).toBe(true);
        expect(isYesNoValues(['Male', 'Female'], 'gender')).toBe(false);
        expect(isYesNoValues(['M', 'F'], 'sex')).toBe(false);
        expect(isYesNoValues(['Urban', 'Rural'])).toBe(false);
        expect(isYesNoValues(['Pass', 'Fail'])).toBe(false);
        expect(isYesNoValues(['Active', 'Inactive'])).toBe(false);
    });

    it('treats coded categories and lone letters by their name', () => {
        expect(isYesNoValues([0, 1], 'gender')).toBe(false);
        expect(isYesNoValues([0, 1], 'gender_code')).toBe(false);
        expect(isYesNoValues([1, 0], 'customer_region')).toBe(false);
        expect(isYesNoValues([0, 1], 'plan_active_flag')).toBe(true);
        expect(isYesNoValues(['F', 'F'], 'gender')).toBe(false);
        expect(isYesNoValues(['F'], 'grade')).toBe(false);
        expect(isYesNoValues(['N'], 'is_vip')).toBe(true);
        expect(isYesNoValues(['Yes', 'Yes'])).toBe(true);
        expect(isLabelName('customer_gender')).toBe(true);
        expect(isLabelName('gender_code')).toBe(true);
        expect(isLabelName('holiday_flag')).toBe(false);
    });
});

describe('every column, end to end', () => {
    const { ds, type, semantic } = load();
    const shape = describeDatasetShape(ds);

    it('keeps two-label columns as categories everywhere', () => {
        for (const name of ['gender', 'sex', 'area', 'result', 'status', 'region', 'plan', 'shift', 'gender_code']) {
            expect(type(name), name).toBe(ColumnType.DIMENSION);
            expect(semantic(name), name).toBe('category');
            expect(shape.yesNo, name).not.toContain(name);
            expect(shape.categories, name).toContain(name);
        }
        // F/M becomes words, never yes/no.
        expect(new Set(ds.rows.map(r => r.sex))).toEqual(new Set(['Male', 'Female']));
    });

    it('reads real yes/no columns as yes/no, whatever they are written as', () => {
        for (const name of ['smoker', 'active_yn', 'is_member', 'churn', 'paid', 'has_kids', 'covid']) {
            expect(type(name), name).toBe(ColumnType.BOOLEAN);
            expect(semantic(name), name).toBe('boolean');
            expect(shape.yesNo, name).toContain(name);
        }
    });

    it('does not mistake ordinary words, scales, years or coordinates for IDs or amounts', () => {
        expect(type('casino')).toBe(ColumnType.DIMENSION);
        expect(type('paid')).toBe(ColumnType.BOOLEAN);
        expect(type('rating')).toBe(ColumnType.METRIC);
        expect(type('year')).toBe(ColumnType.DIMENSION);
        expect(type('latitude')).toBe(ColumnType.DIMENSION);
        expect(semantic('latitude')).toBe('geography');
        expect(shape.amounts).not.toContain('latitude');
        expect(shape.categories).not.toContain('longitude');
        expect(type('order_id')).toBe(ColumnType.ID);
        expect(type('customer_id')).toBe(ColumnType.ID);
    });

    it('tells amounts from figures that belong to each row', () => {
        expect(shape.amounts).toEqual(expect.arrayContaining(['revenue', 'quantity']));
        expect(shape.perRowNumbers).toEqual(expect.arrayContaining(['unit_price', 'discount_pct', 'temperature', 'rating']));
        expect(ds.columns.some(c => c.name === 'rating_allocated')).toBe(false);
    });

    it('shows the labels themselves in answers and the story', () => {
        const answer = relabelYesNo([{ gender: 'Male', n: 3 }, { gender: 'Female', n: 4 }], ['gender']);
        expect(answer.relabelled).toEqual([]);
        expect(answer.rows[0].gender).toBe('Male');
        const story = JSON.stringify(buildDataStory(ds));
        expect(story).not.toMatch(/Not gender|Not sex|Not region|"Gender"|Not area/);
    });
});

describe('number names', () => {
    it('matches whole words', () => {
        expect(isPerRowName('discount_pct')).toBe(true);
        expect(isAdditiveName('discount_pct')).toBe(false);
        expect(isAdditiveName('discount')).toBe(true);
        expect(isPerRowName('unit_price')).toBe(true);
        expect(isPerRowName('total_price')).toBe(false);
        expect(isAdditiveName('weekly_sales')).toBe(true);
        expect(isPerRowName('storage_gb')).toBe(false);
        expect(isPerRowName('percentage')).toBe(true);
        expect(isPerRowName('avg_sales')).toBe(true);
    });
});

describe('the AI profile and saved datasets', () => {
    it('lets the values decide yes/no over the AI', () => {
        const semantics: any = {
            gender: { role: ColumnType.BOOLEAN, aggregation: 'NONE' },
            churn: { role: ColumnType.DIMENSION, aggregation: 'NONE' },
        };
        reconcileRolesWithData(semantics, [
            { name: 'gender', type: ColumnType.DIMENSION },
            { name: 'churn', type: ColumnType.BOOLEAN },
        ] as any);
        expect(semantics.gender.role).toBe(ColumnType.DIMENSION);
        expect(semantics.churn.role).toBe(ColumnType.BOOLEAN);
    });

    it('repairs columns saved as yes/no that hold two labels', () => {
        const rows = [{ gender: 'Male', smoker: 'Yes' }, { gender: 'Female', smoker: 'No' }, { gender: 'Female', smoker: 'N/A' }];
        const columns = [{ name: 'gender', type: 'BOOLEAN' }, { name: 'smoker', type: 'BOOLEAN' }];
        const repaired = repairTwoLabelColumns(columns, rows);
        expect(repaired.map(c => c.type)).toEqual(['DIMENSION', 'BOOLEAN']);
        const unchanged = [columns[1]];
        expect(repairTwoLabelColumns(unchanged, rows)).toBe(unchanged);
    });
});
