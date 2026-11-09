/**
 * Records with nothing to add up (appointments, patients): the app must know
 * what kind of data it has, describe it to the AI the way it is stored, and
 * measure it by counts and rates instead of totals.
 */
import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';
import { runETLPipeline, toTitleCase } from '../services/etlPipeline';
import { describeDatasetShape, shapeForModel } from '../services/datasetShape';
import { buildDataStory } from '../services/dataStory';
import { describeData, buildInsights, planFromResult } from '../services/ai-sql/leanPipeline';
import { buildResultNarrative } from '../services/ai-sql/resultNarrative';
import { buildQuestionExamples } from '../services/ai-sql/scopeIntent';
import { yesNoLabel } from '../services/ai-sql/plainLabels';
import { duckColumnType } from '../utils/duckColumnType';

const PLACES = ['JARDIM DA PENHA', 'MATA DA PRAIA', 'SANTOS DUMONT', 'ILHA DO PRÍNCIPE'];

/** Appointments shaped like the public no-show file: no amounts, a yes/no outcome. */
function appointments(): Record<string, any>[] {
    const out: Record<string, any>[] = [];
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 1600; i++) {
        const wait = i % 4 === 0 ? 0 : Math.floor(rnd() * 60);
        const booked = new Date(Date.UTC(2016, 3, 1 + Math.floor(rnd() * 20)));
        const day = new Date(booked.getTime() + wait * 86_400_000);
        const sms = wait > 3 && rnd() < 0.6;
        // Longer waits are missed more often; same-day almost never.
        const missed = rnd() < (wait === 0 ? 0.04 : 0.15 + wait / 200);
        out.push({
            PatientId: 1000 + (i % 900),
            AppointmentID: 5_600_000 + i,
            Gender: i % 3 === 0 ? 'M' : 'F',
            ScheduledDay: booked.toISOString().slice(0, 10),
            AppointmentDay: day.toISOString().slice(0, 10),
            Age: Math.floor(rnd() * 90),
            Neighbourhood: PLACES[i % PLACES.length],
            Scholarship: rnd() < 0.1,
            Hipertension: rnd() < 0.2,
            SMS_received: sms,
            Showed_up: !missed,
            'Date.diff': wait,
        });
    }
    return out;
}

function dataset(rows: Record<string, any>[], name = 'healthcare_noshows.csv'): Dataset {
    const etl = runETLPipeline(rows, name);
    return { id: 'h', name, rows: etl.rows, columns: etl.columns, totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext } as unknown as Dataset;
}

describe('reading the file', () => {
    it('reads F/M as a category, not as yes/no', () => {
        const etl = runETLPipeline(appointments(), 'a.csv');
        expect(etl.columns.find(c => c.name === 'gender')?.type).toBe(ColumnType.DIMENSION);
        expect(etl.columns.find(c => c.name === 'showed_up')?.type).toBe(ColumnType.BOOLEAN);
        const regions = runETLPipeline(Array.from({ length: 40 }, (_, i) => ({ zone: i % 4 ? 'N' : 'S', units: i })), 'z.csv');
        expect(regions.columns.find(c => c.name === 'zone')?.type).not.toBe(ColumnType.BOOLEAN);
    });

    it('normalises place names typed in capitals', () => {
        expect(toTitleCase('JARDIM DA PENHA')).toBe('Jardim da Penha');
        expect(toTitleCase('ILHA DO PRÍNCIPE')).toBe('Ilha do Príncipe');
        expect(toTitleCase('DO CABRAL')).toBe('Do Cabral');
        expect(toTitleCase('LONDON UK')).toBe('London UK');
        expect(toTitleCase('USA')).toBe('USA');
        expect(toTitleCase('NORTH AMERICA')).toBe('North America');
    });

    it('stores true/false columns as real yes/no in the database', () => {
        expect(duckColumnType([{ a: true }, { a: false }, { a: null }], 'a')).toBe('BOOLEAN');
        expect(duckColumnType([{ a: 'TRUE' }, { a: 'false' }], 'a')).toBe('BOOLEAN');
        expect(duckColumnType([{ a: 'Yes' }, { a: 'No' }], 'a')).toBe('VARCHAR');
        expect(duckColumnType([{ a: 1 }, { a: 0 }], 'a')).toBe('DOUBLE');
        expect(duckColumnType([{ a: true }, { a: 3 }], 'a')).toBe('VARCHAR');
        expect(duckColumnType([{ a: '0012' }, { a: '13' }], 'a')).toBe('VARCHAR');
    });
});

describe('what kind of data is it', () => {
    it('knows appointments have nothing to add up', () => {
        const shape = describeDatasetShape(dataset(appointments()));
        expect(shape.kind).toBe('records');
        expect(shape.countStory).toBe(true);
        expect(shape.outcome).toBe('showed_up');
        expect(shape.rowId).toBe('appointment_id');
        expect(shape.entityIds).toEqual(['patient_id']);
        expect(shape.recordsWord).toBe('appointments');
        expect(shape.perRowNumbers).toEqual(expect.arrayContaining(['age', 'date_diff']));
        expect(shape.dayGaps.date_diff).toEqual({ from: 'scheduled_day', to: 'appointment_day' });
        expect(shape.label).toMatch(/nothing to add up/);
    });

    it('calls sales data hybrid and readings-only data measures', () => {
        const sales = dataset(Array.from({ length: 60 }, (_, i) => ({ order_date: `2025-0${1 + (i % 6)}-10`, region: ['North', 'South'][i % 2], revenue: 100 + i })), 's.csv');
        expect(describeDatasetShape(sales).kind).toBe('hybrid');
        const cars = dataset(Array.from({ length: 30 }, (_, i) => ({ make: ['Ford', 'BMW'][i % 2], unit_price: 20000 + i * 100 })), 'cars.csv');
        expect(describeDatasetShape(cars).kind).toBe('hybrid');
        expect(describeDatasetShape(cars).countStory).toBe(false);
        const readings = dataset(Array.from({ length: 60 }, (_, i) => ({ reading_date: `2025-01-${String(1 + (i % 28)).padStart(2, '0')}`, temperature: Math.round((10 + ((i * 7.3) % 15)) * 10) / 10, humidity: Math.round((40 + ((i * 3.7) % 30)) * 10) / 10 })), 'r.csv');
        expect(describeDatasetShape(readings).kind).toBe('measures');
    });
});

describe('what the AI is told', () => {
    it('describes the columns as stored and how to measure them, with no values', () => {
        const ds = dataset(appointments());
        const text = describeData(ds).schema;
        expect(text).toContain('"showed_up": BOOLEAN; yes/no');
        expect(text).toContain('"appointment_id": NUMBER; identifier (unique per row)');
        expect(text).toMatch(/"patient_id": NUMBER; identifier \(repeats/);
        expect(text).toMatch(/"age": NUMBER; number describing each row/);
        expect(text).toContain('"gender": TEXT; category');
        expect(text).toContain('DATA SHAPE: records with nothing to add up.');
        expect(text).toContain('COUNT_IF("showed_up")');
        expect(text).toContain('"date_diff" is the number of days from "scheduled_day" to "appointment_day"');
        expect(text).toContain('also return the number of rows in that group');
        expect(text).not.toContain('HAVING COUNT(*) >= 30');
        for (const place of ['Penha', 'Dumont', 'Praia']) expect(text).not.toContain(place);
    });

    it('writes the yes test to match how a yes/no is stored', () => {
        const shape = describeDatasetShape(dataset(appointments()));
        expect(shapeForModel(shape, c => `LOWER("${c}") IN ('yes')`)).toContain(`COUNT_IF(LOWER("showed_up") IN ('yes'))`);
    });
});

describe('yes/no in words', () => {
    it('says what did not happen naturally', () => {
        expect(yesNoLabel('showed_up', false)).toBe("Didn't show up");
        expect(yesNoLabel('showed_up', true)).toBe('Showed up');
        expect(yesNoLabel('sms_received', false)).toBe('SMS not received');
        expect(yesNoLabel('SMS_received', true)).toBe('SMS received');
        expect(yesNoLabel('Holiday_Flag', 0)).toBe('Not holiday');
        expect(yesNoLabel('churned', 1)).toBe('Churned');
        expect(yesNoLabel('churned', 0)).toBe("Didn't churn");
    });
});

describe('the data story for records', () => {
    it('counts appointments and compares the share that did not show up', () => {
        const story = buildDataStory(dataset(appointments()));
        const overview = story.findings[0];
        expect(story.subtitle).toMatch(/^Appointments · 1,600 rows/);
        expect(overview.headline).toMatch(/^1,600 appointments for 900 patients/);
        expect(overview.headline).toMatch(/% didn't show up\.$/);
        expect(overview.kpis?.map(k => k.label)).toEqual(expect.arrayContaining(['Appointments', 'Patients', "Didn't show up"]));
        expect(story.findings.some(f => /^Total /.test(f.kpis?.[0]?.label || ''))).toBe(false);
        const wait = story.findings.find(f => f.id === 'driver_date_diff')!;
        expect(wait.headline).toMatch(/^The longer the wait from scheduled day to appointment day, the higher the share that didn't show up/);
        expect(wait.chart?.numberFormat).toBe('percent_points');
        const sms = story.findings.find(f => f.id === 'driver_sms_received');
        if (sms) expect(sms.points.join(' ')).toMatch(/Careful: “SMS received” appointments also differ on days from scheduled day to appointment day/);
        const repeats = story.findings.find(f => f.id === 'repeats');
        expect(repeats?.headline).toMatch(/patients didn't show up two or more times/);
        // Age stays a number (bands), never "Age 62" as a grouping.
        expect(JSON.stringify(story.findings)).not.toMatch(/Age \d+"/);
    });

    it('offers count and rate questions to start with', () => {
        const questions = buildQuestionExamples(dataset(appointments()));
        expect(questions[0]).toBe("What % of appointments didn't show up, by neighbourhood?");
        expect(questions.join(' ')).toMatch(/longer wait from scheduled day to appointment day/);
        expect(questions.join(' ')).not.toMatch(/total/i);
    });
});

describe('answers that are rates', () => {
    const rows = [
        { neighbourhood: 'Santos Dumont', appointments: 1249, no_show_rate_pct: 29.1 },
        { neighbourhood: 'Itararé', appointments: 3500, no_show_rate_pct: 26.3 },
        { neighbourhood: 'Do Cabral', appointments: 560, no_show_rate_pct: 15.7 },
    ];
    it('leads with the rate and never adds rates up', () => {
        const plan = planFromResult('No-show rate by neighbourhood', rows, { dimensions: ['neighbourhood'], measures: ['appointments', 'no_show_rate_pct'] });
        expect(plan.metrics[0]).toEqual({ field: 'no_show_rate_pct', agg: 'avg' });
        const profile = { metricColumns: ['appointments', 'no_show_rate_pct'], dimensionColumns: ['neighbourhood'], metricSemanticTypes: { no_show_rate_pct: 'percentage', appointments: 'count' }, hasTimeDimension: false } as any;
        const insights = buildInsights(rows, { ...profile, metricColumns: ['no_show_rate_pct', 'appointments'] }, plan);
        expect(insights[0]).toBe('Santos Dumont is highest at 29.1%, 2.8 points above Itararé (26.3%).');
        expect(insights.join(' ')).not.toMatch(/make up/);
        const narrative = buildResultNarrative({ question: 'No-show rate by neighbourhood', data: rows, profile, chart: {} as any, plan, model: { fields: [] } as any });
        expect(narrative?.headline).toBe('Santos Dumont has the highest no show rate');
        expect(narrative?.summary).not.toMatch(/of the total/);
    });

    it('compares two rates in points', () => {
        const two = [{ sms_received: 'SMS received', no_show_rate_pct: 27.7 }, { sms_received: 'SMS not received', no_show_rate_pct: 16.7 }];
        const plan = planFromResult('No-show rate with and without SMS', two, { dimensions: ['sms_received'], measures: ['no_show_rate_pct'] });
        const profile = { metricColumns: ['no_show_rate_pct'], dimensionColumns: ['sms_received'], metricSemanticTypes: { no_show_rate_pct: 'percentage' }, hasTimeDimension: false } as any;
        const narrative = buildResultNarrative({ question: 'No-show rate with and without SMS', data: two, profile, chart: {} as any, plan, model: { fields: [] } as any });
        expect(narrative?.summary).toBe('No show rate is 27.7% for SMS received and 16.7% for SMS not received, a gap of 11 points.');
    });
});
