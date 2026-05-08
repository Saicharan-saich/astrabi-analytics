/**
 * ═══════════════════════════════════════════════════════════════════
 * LIVE REFRESH SERVICE
 * ═══════════════════════════════════════════════════════════════════
 * Handles refreshing data from a live database connection.
 * Used when a dataset is in 'live' connection mode — re-fetches
 * table data from the source RDBMS and re-joins if multi-table.
 */

import { LiveConnectionInfo } from '../types';
import { autoJoinDatasets } from './analysisEngine';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://api.quickinsight.co.uk';

/**
 * Refresh a live dataset by re-fetching all source tables from the database
 * and re-joining them using the original join strategy.
 * 
 * @returns Fresh merged rows from the live database
 */
export async function refreshLiveDataset(
  liveConnection: LiveConnectionInfo
): Promise<{ rows: Record<string, any>[]; executionTimeMs: number }> {
  const { connectionId, tables, joinEdges } = liveConnection;

  console.log(`[LiveRefresh] Refreshing ${tables.length} tables from live connection ${connectionId}`);

  const response = await fetch(`${API_BASE_URL}/api/refresh-data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': import.meta.env.VITE_API_KEY || '',
    },
    body: JSON.stringify({ connectionId, tables }),
  });

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || 'Failed to refresh data from database');
  }

  // If single table, return directly
  if (tables.length === 1) {
    const rows = data.data[tables[0]] || [];
    console.log(`[LiveRefresh] Single table: ${rows.length} rows in ${data.executionTimeMs}ms`);
    return { rows, executionTimeMs: data.executionTimeMs };
  }

  // Multi-table: re-join using the original join edges
  const tableData = data.data;
  const { mergedRows } = autoJoinDatasets(tableData, joinEdges);

  console.log(`[LiveRefresh] Merged ${tables.length} tables → ${mergedRows.length} rows in ${data.executionTimeMs}ms`);
  return { rows: mergedRows, executionTimeMs: data.executionTimeMs };
}

/**
 * Check if a live connection is still active on the backend.
 */
export async function checkLiveConnection(connectionId: string): Promise<boolean> {
  try {
    // Use a lightweight query to test the connection
    const response = await fetch(`${API_BASE_URL}/api/refresh-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': import.meta.env.VITE_API_KEY || '',
      },
      body: JSON.stringify({ connectionId, tables: [], dbType: 'mssql' }),
    });
    const data = await response.json();
    // If connection is invalid, the backend returns 400
    return response.ok || data.success;
  } catch {
    return false;
  }
}
