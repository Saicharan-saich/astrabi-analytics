import type { AnalysisResult, DashboardItem } from '../types';

const DEFAULT_VISUAL_TITLE = 'Untitled Visual';

/**
 * Titles are user-owned dashboard metadata. Generated result labels are useful
 * defaults, but they must never overwrite a title that a user has chosen.
 */
export function normalizeDashboardVisualTitle(
  title: string | null | undefined,
  fallback = DEFAULT_VISUAL_TITLE,
): string {
  const normalized = title?.trim();
  return normalized || fallback;
}

export function titleDashboardItem(item: DashboardItem, title: string): DashboardItem {
  return {
    ...item,
    title: normalizeDashboardVisualTitle(title, normalizeDashboardVisualTitle(item.title)),
  };
}

/**
 * Replace the analysis payload after an edit while preserving the card's
 * identity, user title, layout, dataset provenance, and filter preferences.
 */
export function saveEditedDashboardItem(
  existingItem: DashboardItem,
  result: AnalysisResult,
  explicitTitle?: string,
): DashboardItem {
  return {
    ...existingItem,
    title: normalizeDashboardVisualTitle(
      explicitTitle,
      normalizeDashboardVisualTitle(existingItem.title, result.insight || 'Updated Analysis'),
    ),
    result,
  };
}
