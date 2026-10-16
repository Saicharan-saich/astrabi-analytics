import { ColumnType, type Dataset } from '../types';

/** The Builder is an explicit user tool: AI profile visibility must not hide
 * physical upload columns, and boolean flags are categorical fields. */
export function questionBuilderColumns(dataset: Dataset) {
    const columns = dataset.columns;
    const metrics = columns.filter(column => column.type === ColumnType.METRIC).map(column => column.name);
    const countable = columns.filter(column =>
        column.type === ColumnType.DIMENSION
        || column.type === ColumnType.ID
        || column.type === ColumnType.BOOLEAN,
    ).map(column => column.name);
    const dates = columns.filter(column => column.type === ColumnType.DATE).map(column => column.name);
    return { metrics, dimensions: countable, countable, dates };
}
