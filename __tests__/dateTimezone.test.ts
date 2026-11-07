import { afterAll, describe, expect, it } from 'vitest';
import { dateKeyOf, localDateKey } from '../utils/dateKey';
import { runETLPipeline } from '../services/etlPipeline';

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

// A user in India, in the UK in summer, or in New York must see the same day.
for (const zone of ['Asia/Kolkata', 'Europe/London', 'America/New_York', 'UTC']) {
    describe(`dates keep their written day (${zone})`, () => {
        it('reads written dates and Date objects on the calendar day', () => {
            process.env.TZ = zone;
            expect(dateKeyOf('1 June 2025')).toBe('2025-06-01');
            expect(dateKeyOf('Jun 1, 2025')).toBe('2025-06-01');
            expect(dateKeyOf('2025-06-01')).toBe('2025-06-01');
            expect(dateKeyOf('2025-06-01T23:30:00')).toBe('2025-06-01');
            expect(localDateKey(new Date(2025, 5, 1))).toBe('2025-06-01');
        });

        it('the cleaned data and its date range keep 1 June in June', () => {
            process.env.TZ = zone;
            const raw = [
                { order_date: '1 June 2025', sales: 10 }, { order_date: '15 June 2025', sales: 20 },
                { order_date: '1 July 2025', sales: 30 }, { order_date: '31 July 2025', sales: 40 },
            ];
            const result = runETLPipeline(raw, 'orders.csv');
            expect(result.rows.map(row => String(row.order_date).slice(0, 10))).toEqual(['2025-06-01', '2025-06-15', '2025-07-01', '2025-07-31']);
            const range = result.timeContext as any;
            if (range?.minDate) expect(String(range.minDate).slice(0, 10)).toBe('2025-06-01');
        });
    });
}
