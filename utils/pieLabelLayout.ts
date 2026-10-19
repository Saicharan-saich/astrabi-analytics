export interface PieLabelRow {
    index: number;
    preferredY: number;
    weight: number;
}

/** Place the most informative outside labels without vertical collisions. */
export function layoutPieLabelRows(
    rows: PieLabelRow[],
    height: number,
    margin = 14,
    gap = 20,
): Array<{ index: number; y: number }> {
    if (!Number.isFinite(height) || height <= margin * 2 || !rows.length) return [];
    const capacity = Math.floor((height - margin * 2) / gap) + 1;
    const chosen = [...rows]
        .sort((a, b) => b.weight - a.weight || a.index - b.index)
        .slice(0, capacity)
        .sort((a, b) => a.preferredY - b.preferredY || a.index - b.index);
    const positions: Array<{ index: number; y: number }> = [];
    chosen.forEach((row, index) => {
        const wanted = Math.max(margin, Math.min(height - margin, row.preferredY));
        positions.push({ index: row.index, y: index ? Math.max(wanted, positions[index - 1].y + gap) : wanted });
    });
    if (positions[positions.length - 1].y > height - margin) {
        positions[positions.length - 1].y = height - margin;
        for (let index = positions.length - 2; index >= 0; index--) {
            positions[index].y = Math.min(positions[index].y, positions[index + 1].y - gap);
        }
    }
    return positions;
}

/** Keep labels inside their half of the canvas; the full name remains in the tooltip. */
export function fitPieLabelText(text: string, maxWidth: number, measure: (text: string) => number): string {
    if (maxWidth <= 0 || measure('…') > maxWidth) return '';
    if (measure(text) <= maxWidth) return text;
    const percentSuffix = text.match(/: \d+(?:\.\d+)?%$/)?.[0] || '';
    if (percentSuffix) {
        const category = text.slice(0, -percentSuffix.length);
        const suffix = percentSuffix.slice(2);
        if (measure(suffix) > maxWidth) return '';
        const categoryWidth = maxWidth - measure(`… ${suffix}`);
        if (categoryWidth <= 0) return suffix;
        let low = 0;
        let high = category.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (measure(category.slice(0, middle)) <= categoryWidth) low = middle;
            else high = middle - 1;
        }
        return `${category.slice(0, low).trimEnd()}… ${suffix}`;
    }
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (measure(`${text.slice(0, middle)}…`) <= maxWidth) low = middle;
        else high = middle - 1;
    }
    return `${text.slice(0, low).trimEnd()}…`;
}
