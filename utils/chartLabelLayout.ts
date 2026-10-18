export interface ChartLabelBounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface ChartLabelCandidate {
    x: number;
    y: number;
    width: number;
    height: number;
    horizontal: boolean;
    positive: boolean;
    minX?: number;
    maxX?: number;
    preferredDirection?: 'above' | 'below';
}

export interface ChartLabelPosition {
    x: number;
    y: number;
}

interface LabelBox extends ChartLabelBounds {}

const EDGE_INSET = 3;
const LABEL_GAP = 4;

function boxAt(x: number, y: number, width: number, height: number): LabelBox {
    return {
        left: x - width / 2,
        right: x + width / 2,
        top: y - height / 2,
        bottom: y + height / 2,
    };
}

function fits(box: LabelBox, bounds: ChartLabelBounds): boolean {
    return box.left >= bounds.left + EDGE_INSET
        && box.right <= bounds.right - EDGE_INSET
        && box.top >= bounds.top + EDGE_INSET
        && box.bottom <= bounds.bottom - EDGE_INSET;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
    return a.left < b.right + LABEL_GAP
        && a.right + LABEL_GAP > b.left
        && a.top < b.bottom + LABEL_GAP
        && a.bottom + LABEL_GAP > b.top;
}

function candidatePositions(label: ChartLabelCandidate): ChartLabelPosition[] {
    const { x, y, width, height, horizontal, positive } = label;
    const verticalStep = height + 7;
    const horizontalStep = width + 12;
    const preferred = label.preferredDirection === 'below' ? 1
        : label.preferredDirection === 'above' ? -1
            : positive ? -1 : 1;
    const points: ChartLabelPosition[] = [];

    if (horizontal) {
        // Prefer outside the bar, then flip inward at an axis edge. Nearby
        // rows are useful when several series end at the same pixel.
        for (const direction of [positive ? 1 : -1, positive ? -1 : 1]) {
            for (const row of [0, -1, 1, -2, 2]) {
                points.push({
                    x: x + direction * (width / 2 + 9),
                    y: y + row * verticalStep,
                });
            }
        }
    } else {
        // Every series participates in one layout. This prevents a percent
        // marker on y1 and a currency bar on y from painting over each other.
        for (const direction of [preferred, -preferred]) {
            // Compact facets and cross-platform font metrics can leave the
            // first few slots occupied. Search farther only as a fallback;
            // the nearest valid position still wins.
            for (const row of [1, 2, 3, 4, 5, 6]) {
                for (const column of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
                    points.push({
                        x: x + column * horizontalStep,
                        y: y + direction * (height / 2 + 8 + (row - 1) * verticalStep),
                    });
                }
            }
        }
    }
    return points;
}

/**
 * Lay out all Cartesian chart labels together. A label is omitted only when
 * no position fits the plot without covering a previously placed label;
 * its value remains available in the chart tooltip.
 */
export function layoutChartLabels(
    labels: ChartLabelCandidate[],
    bounds: ChartLabelBounds,
): Array<ChartLabelPosition | null> {
    const occupied: LabelBox[] = [];
    return labels.map(label => {
        if (!Number.isFinite(label.x) || !Number.isFinite(label.y)
            || !Number.isFinite(label.width) || !Number.isFinite(label.height)
            || label.width <= 0 || label.height <= 0) return null;

        const localBounds = {
            ...bounds,
            left: Math.max(bounds.left, label.minX ?? bounds.left),
            right: Math.min(bounds.right, label.maxX ?? bounds.right),
        };
        for (const point of candidatePositions(label)) {
            const box = boxAt(point.x, point.y, label.width, label.height);
            if (!fits(box, localBounds) || occupied.some(other => overlaps(box, other))) continue;
            occupied.push(box);
            return point;
        }
        return null;
    });
}
