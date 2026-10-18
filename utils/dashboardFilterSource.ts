import type { DashboardItem, Dataset } from '../types';

/** Resolve a pin to its local source, including a uniquely re-imported workbook. */
export function resolveDashboardFilterSource(
  item: DashboardItem,
  current: Dataset | undefined,
  datasets: Dataset[],
): Dataset | undefined {
  if (!item.datasetId) return current;
  const exact = datasets.find(candidate => candidate.id === item.datasetId);
  if (exact) return exact;
  if (current?.id === item.datasetId) return current;
  if (!item.datasetName) return undefined;

  // A re-import gives the same workbook a new ID. Only reconnect when one
  // local dataset has that exact name; never guess between multiple versions.
  const matches = [...datasets, ...(current && !datasets.some(candidate => candidate.id === current.id) ? [current] : [])]
    .filter(candidate => candidate.name === item.datasetName);
  return matches.length === 1 ? matches[0] : undefined;
}

export function dashboardFilterColumnExists(dataset: Dataset, column: string): boolean {
  return dataset.columns.some(candidate => candidate.name === column)
    || (dataset.rows.length > 0 && Object.prototype.hasOwnProperty.call(dataset.rows[0], column));
}
