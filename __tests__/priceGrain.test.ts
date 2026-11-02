import { describe, expect, it } from 'vitest';
import { AggregationType, ColumnType, type ColumnDefinition, type Dataset } from '../types';
import { buildSemanticModel, priceIsSaleAmount, reconcileStoredModelGrain } from '../services/semanticModel';
import { inferDefaultAggregationForGrain } from '../services/smartAggregation';
import { runAnalysis } from '../services/analysisEngine';

const col = (name: string, type: ColumnType): ColumnDefinition => ({ name, type, originalType: 'string' });
const makers = ['Ford', 'Toyota', 'Honda', 'BMW'];

/** Raw car sales: one dated row per car sold, the price is the sale amount. */
function carSales(): Dataset {
    const columns = [
        col('car_id', ColumnType.ID), col('date', ColumnType.DATE), col('company', ColumnType.DIMENSION),
        col('dealer_region', ColumnType.DIMENSION), col('annual_income', ColumnType.METRIC), col('price', ColumnType.METRIC),
    ];
    const rows = Array.from({ length: 40 }, (_, i) => ({
        car_id: `C${i}`, date: `2023-0${(i % 9) + 1}-15`, company: makers[i % 4],
        dealer_region: i % 2 ? 'Austin' : 'Scottsdale', annual_income: 30000 + i, price: 20000 + i * 100,
    }));
    const dataset = { id: 'cars', name: 'car_data.csv', rows, columns, totalRows: rows.length, version: 1 } as unknown as Dataset;
    dataset.semanticModel = buildSemanticModel(dataset);
    return dataset;
}

describe('price aggregation follows what one row is', () => {
    it('totals the price when each row is one sale and there is no quantity column', () => {
        const dataset = carSales();
        const price = dataset.semanticModel!.measures.find(m => m.column === 'price')!;
        expect(price.aggregation).toBe(AggregationType.SUM);
        expect(price.behavior).toBe('additive');
        expect(dataset.semanticModel!.warnings.join(' ')).toContain('Total adds it up');
    });

    it('runs Total as SUM(price) and returns the real total sales', async () => {
        const dataset = carSales();
        const result = await runAnalysis(dataset, { questionId: 'custom_builder', metric: 'price', aggregation: AggregationType.SUM, dimension: 'company' } as any);
        expect(result.sql).toContain('SUM("price")');
        expect(result.sql).not.toContain('AVG(');
        const total = result.data.reduce((sum: number, row: any) => sum + Number(row[result.yKey]), 0);
        expect(total).toBe(dataset.rows.reduce((sum, row) => sum + row.price, 0));
        expect(result.notices).toBeUndefined();
    });

    it('keeps a per-unit price averaged, weighted by the real quantity column', () => {
        const columns = [col('order_date', ColumnType.DATE), col('manufacturer', ColumnType.DIMENSION),
            col('units_sold', ColumnType.METRIC), col('unit_price', ColumnType.METRIC), col('sales', ColumnType.METRIC)];
        const rows = [{ order_date: '2024-01-01', manufacturer: 'Ford', units_sold: 2, unit_price: 100, sales: 200 }];
        const model = buildSemanticModel({ id: 'u', name: 'u.csv', rows, columns, totalRows: 1, version: 1 } as unknown as Dataset);
        const unitPrice = model.measures.find(m => m.column === 'unit_price')!;
        expect(unitPrice.aggregation).toBe(AggregationType.AVG);
        expect(unitPrice.weightColumn).toBe('units_sold');
    });

    it('keeps a price averaged when the table has its own sales amount or is a price list', () => {
        const withSales = [col('sale_date', ColumnType.DATE), col('sale_price', ColumnType.METRIC), col('total_sales', ColumnType.METRIC)];
        expect(priceIsSaleAmount('sale_price', withSales)).toBe(false);
        const catalogue = [col('model', ColumnType.DIMENSION), col('price', ColumnType.METRIC)];
        expect(priceIsSaleAmount('price', catalogue, 'price_list.csv')).toBe(false);
        expect(priceIsSaleAmount('unit_price', [col('date', ColumnType.DATE), col('unit_price', ColumnType.METRIC)])).toBe(false);
    });

    // second_hand_car_sales.csv: Manufacturer, Model, Engine Size (L), Fuel Type,
    // Year of Manufacture, Mileage, Price (£) — no sale date, no ID column.
    const usedCarColumns = [
        col('manufacturer', ColumnType.DIMENSION), col('model', ColumnType.DIMENSION), col('fuel_type', ColumnType.DIMENSION),
        col('year_of_manufacture', ColumnType.DIMENSION), col('engine_size_l', ColumnType.METRIC),
        col('mileage', ColumnType.METRIC), col('price', ColumnType.METRIC),
    ];
    const usedCars = (name: string): Dataset => {
        const rows = Array.from({ length: 30 }, (_, i) => ({
            manufacturer: makers[i % 4], model: `M${i % 5}`, fuel_type: i % 2 ? 'Petrol' : 'Electric',
            year_of_manufacture: String(2000 + (i % 20)), engine_size_l: 1.2 + (i % 3), mileage: 20000 + i * 1000, price: 9000 + i * 500,
        }));
        const dataset = { id: name, name, rows, columns: usedCarColumns, totalRows: rows.length, version: 1 } as unknown as Dataset;
        dataset.semanticModel = buildSemanticModel(dataset);
        return dataset;
    };

    it('totals the price of a sales file with no sale date or ID column', async () => {
        const dataset = usedCars('second_hand_car_sales.csv');
        const price = dataset.semanticModel!.measures.find(m => m.column === 'price')!;
        expect(price.aggregation).toBe(AggregationType.SUM);
        const result = await runAnalysis(dataset, { questionId: 'custom_builder', metric: 'price', aggregation: AggregationType.SUM, dimension: 'manufacturer' } as any);
        expect(result.sql).toContain('SUM("price")');
        expect(result.notices).toBeUndefined();
        expect((result.warnings || []).join(' ')).not.toMatch(/grain/i);
    });

    it('always allows a Total on a plain price, even in a price list', async () => {
        const dataset = usedCars('car_listing.csv');
        const price = dataset.semanticModel!.measures.find(m => m.column === 'price')!;
        expect(price.aggregation).toBe(AggregationType.AVG);
        expect(price.behavior).toBe('additive');
        const result = await runAnalysis(dataset, { questionId: 'custom_builder', metric: 'price', aggregation: AggregationType.SUM, dimension: 'manufacturer' } as any);
        expect(result.sql).toContain('SUM("price")');
    });

    it('averages mileage by default but still allows a total', () => {
        const mileage = usedCars('second_hand_car_sales.csv').semanticModel!.measures.find(m => m.column === 'mileage')!;
        expect(mileage.aggregation).toBe(AggregationType.AVG);
        expect(mileage.behavior).toBe('additive');
    });

    it('says Total for the price in the column review of raw sales data', () => {
        const columns = carSales().columns;
        expect(inferDefaultAggregationForGrain('price', 'METRIC', columns)).toBe('SUM');
        expect(inferDefaultAggregationForGrain('rating', 'METRIC', columns)).toBe('AVG');
    });

    it('repairs a dataset saved with the old averaged price', () => {
        const dataset = carSales();
        const stale = {
            ...dataset,
            semanticModel: {
                ...dataset.semanticModel!,
                measures: dataset.semanticModel!.measures.map(m => m.column === 'price'
                    ? { ...m, aggregation: AggregationType.AVG, behavior: 'non_additive' as const, requiresWeighting: true, weightColumn: 'quantity' }
                    : m),
            },
        };
        const repaired = reconcileStoredModelGrain(stale);
        expect(repaired).not.toBe(stale);
        expect(repaired.semanticModel!.measures.find(m => m.column === 'price')!.aggregation).toBe(AggregationType.SUM);
        expect(reconcileStoredModelGrain(repaired)).toBe(repaired);
    });

    it('explains, rather than hides, a Total it cannot give', async () => {
        const columns = [col('model', ColumnType.DIMENSION), col('rating', ColumnType.METRIC)];
        const rows = [{ model: 'A', rating: 4 }, { model: 'B', rating: 2 }];
        const dataset = { id: 'r', name: 'r.csv', rows, columns, totalRows: 2, version: 1 } as unknown as Dataset;
        dataset.semanticModel = buildSemanticModel(dataset);
        const result = await runAnalysis(dataset, { questionId: 'custom_builder', metric: 'rating', aggregation: AggregationType.SUM, dimension: 'model' } as any);
        expect(result.sql).toContain('AVG(');
        expect(result.notices?.[0]).toContain('A total of "rating" would not mean anything');
    });
});
