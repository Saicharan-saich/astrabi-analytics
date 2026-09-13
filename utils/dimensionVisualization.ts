export type DimensionViewMode = 'auto' | 'grid' | 'combined';

export interface DimensionVisualizationLayout {
    useGrid: boolean;
    facetKey?: string;
    seriesKey?: string;
    rows: Record<string, any>[];
    groupedDimensions: string[];
}

const MAX_FACETS = 50;
const IDEAL_MAX_FACETS = 12;
const COMPOSITE_SERIES_KEY = '__qi_group_series';

/**
 * Assign every requested GROUP BY field a visible role. The result rows remain
 * untouched unless multiple dimensions need a composite chart legend.
 */
export function resolveDimensionVisualization(
    rows: Record<string, any>[],
    xKey: string,
    yKey: string,
    config: { dimension?: string; secondaryDimensions?: string[] } | undefined,
    mode: DimensionViewMode,
): DimensionVisualizationLayout {
    if (!rows.length) return { useGrid: false, rows, groupedDimensions: [] };

    const available = new Set(Object.keys(rows[0]));
    const requested = [config?.dimension, ...(config?.secondaryDimensions || [])]
        .filter((key): key is string => !!key && available.has(key) && key !== yKey);
    const groupedDimensions = [...new Set([xKey, ...requested])];
    const secondary = groupedDimensions.filter(key => key !== xKey);
    const facetCandidates = secondary
        .map(key => ({ key, count: new Set(rows.map(row => String(row[key] ?? 'Unknown'))).size }))
        .filter(candidate => candidate.count > 0 && candidate.count <= MAX_FACETS);

    // An analyst's last added dimension is the preferred panel split. If it
    // would create too many panels, use another requested dimension instead.
    const preferredFacet = [...facetCandidates].reverse().find(c => c.count <= IDEAL_MAX_FACETS)
        || [...facetCandidates].reverse()[0];
    const facetKey = preferredFacet?.key;
    const facetCount = preferredFacet?.count || 0;
    const useGrid = !!facetKey && (
        mode === 'grid' ||
        (mode === 'auto' && (
            groupedDimensions.length >= 3 ||
            (facetCount > 4 && facetCount <= IDEAL_MAX_FACETS)
        ))
    );

    // Combined must not sum different facet values into the same x/series
    // mark. Keep all non-X dimensions in the legend, even in manual mode.
    const seriesDimensions = secondary.filter(key => !useGrid || key !== facetKey);
    if (seriesDimensions.length <= 1) {
        return {
            useGrid,
            facetKey,
            seriesKey: seriesDimensions[0],
            rows,
            groupedDimensions,
        };
    }

    return {
        useGrid,
        facetKey,
        seriesKey: COMPOSITE_SERIES_KEY,
        rows: rows.map(row => ({
            ...row,
            [COMPOSITE_SERIES_KEY]: seriesDimensions
                .map(key => `${key.replace(/_/g, ' ')}: ${String(row[key] ?? 'Unknown')}`)
                .join(' · '),
        })),
        groupedDimensions,
    };
}
