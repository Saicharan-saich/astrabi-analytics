/**
 * Presentation plugins for the clean chart style.
 *
 *  - qiDoughnutCenter: writes the total in the hole of a doughnut chart.
 *  - qiStackTotals:    writes each stack's total above a stacked bar.
 *
 * Both read their settings from `options.plugins.<id>` and draw only when
 * `display` is true, so charts that do not opt in are unaffected.
 */

export interface DoughnutCenterOptions {
    display?: boolean;
    /** Formatted headline (e.g. "18,016"). */
    text?: string;
    /** Small caption under the headline (e.g. "Total"). */
    caption?: string;
    color?: string;
    captionColor?: string;
    fontFamily?: string;
    /** 'above' places the text above the centre (half-ring gauges). */
    anchor?: 'middle' | 'above';
}

export interface StackTotalsOptions {
    display?: boolean;
    formatter?: (value: number) => string;
    color?: string;
    fontFamily?: string;
    horizontal?: boolean;
}

export const doughnutCenterPlugin = {
    id: 'qiDoughnutCenter',
    afterDraw(chart: any, _args: unknown, options: DoughnutCenterOptions) {
        if (!options?.display || !options.text) return;
        const meta = chart.getDatasetMeta?.(0);
        const arc = meta?.data?.[0];
        if (!arc || !arc.innerRadius) return;
        const inner = arc.innerRadius as number;
        if (inner < 28) return; // too small to hold readable text
        const { ctx } = chart;
        const x = arc.x as number;
        const y = arc.y as number;
        const family = options.fontFamily || 'Inter, system-ui, sans-serif';
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Fit the headline inside ~75% of the hole's diameter.
        let size = Math.min(30, Math.max(14, inner * 0.42));
        ctx.font = `700 ${size}px ${family}`;
        while (size > 12 && ctx.measureText(options.text).width > inner * 1.5) {
            size -= 1;
            ctx.font = `700 ${size}px ${family}`;
        }
        const captionSize = Math.max(10, Math.round(size * 0.42));
        const gap = options.caption ? captionSize * 0.75 : 0;
        const above = options.anchor === 'above';
        const headlineY = above ? y - size * 0.55 - (options.caption ? captionSize * 1.2 : 0) : y - gap;
        const captionY = above ? y - captionSize * 0.7 : y + size * 0.62;
        ctx.fillStyle = options.color || '#1f2430';
        ctx.fillText(options.text, x, headlineY);
        if (options.caption) {
            ctx.font = `500 ${captionSize}px ${family}`;
            ctx.fillStyle = options.captionColor || '#8a92a3';
            ctx.fillText(options.caption, x, captionY);
        }
        ctx.restore();
    },
};

export const stackTotalsPlugin = {
    id: 'qiStackTotals',
    afterDatasetsDraw(chart: any, _args: unknown, options: StackTotalsOptions) {
        if (!options?.display) return;
        const datasets: any[] = chart.data?.datasets || [];
        const visible = datasets
            .map((dataset, index) => ({ dataset, meta: chart.getDatasetMeta(index) }))
            .filter(({ meta }) => meta && !meta.hidden && meta.type === 'bar');
        if (visible.length < 2) return; // a single series is not a stack

        const count = Math.max(...visible.map(({ meta }) => meta.data.length));
        const { ctx, chartArea } = chart;
        const family = options.fontFamily || 'Inter, system-ui, sans-serif';
        const format = options.formatter || ((value: number) => value.toLocaleString());
        ctx.save();
        ctx.font = `600 11px ${family}`;
        ctx.fillStyle = options.color || '#1f2430';

        for (let index = 0; index < count; index += 1) {
            let total = 0;
            let edge: number | null = null;
            for (const { dataset, meta } of visible) {
                const raw = Number(dataset.data?.[index]);
                if (!Number.isFinite(raw)) continue;
                total += raw;
                const element = meta.data[index];
                if (!element) continue;
                const props = element.getProps ? element.getProps(['x', 'y'], true) : element;
                const end = options.horizontal ? props.x : props.y;
                if (edge === null) edge = end;
                else edge = options.horizontal ? Math.max(edge, end) : Math.min(edge, end);
            }
            if (edge === null || total === 0) continue;
            const firstElement = visible[0].meta.data[index];
            if (!firstElement) continue;
            const anchor = firstElement.getProps ? firstElement.getProps(['x', 'y'], true) : firstElement;
            const text = format(total);
            if (options.horizontal) {
                const x = Math.min(edge + 6, chartArea.right - ctx.measureText(text).width);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, x, anchor.y);
            } else {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(text, anchor.x, Math.max(chartArea.top + 10, edge - 4));
            }
        }
        ctx.restore();
    },
};

export interface TargetLineOptions {
    display?: boolean;
    value?: number;
    /** e.g. "Target 50k". */
    text?: string;
    color?: string;
    fontFamily?: string;
    /** Bars run left to right: the line is vertical. */
    horizontal?: boolean;
}

/**
 * qiTarget: a dashed target or budget line across the plot, labelled at its
 * end. Drawn after the datasets so it sits on top of bars.
 */
export const targetLinePlugin = {
    id: 'qiTarget',
    afterDatasetsDraw(chart: any, _args: unknown, options: TargetLineOptions) {
        if (!options?.display || !Number.isFinite(options.value)) return;
        const scale = chart.scales?.[options.horizontal ? 'x' : 'y'];
        const area = chart.chartArea;
        if (!scale || !area) return;
        const at = scale.getPixelForValue(options.value);
        if (!Number.isFinite(at)) return;
        const { ctx } = chart;
        const color = options.color || '#b45309';
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        if (options.horizontal) {
            if (at < area.left - 1 || at > area.right + 1) { ctx.restore(); return; }
            ctx.moveTo(at, area.top);
            ctx.lineTo(at, area.bottom);
        } else {
            if (at < area.top - 1 || at > area.bottom + 1) { ctx.restore(); return; }
            ctx.moveTo(area.left, at);
            ctx.lineTo(area.right, at);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        if (options.text) {
            ctx.font = `600 11px ${options.fontFamily || 'Inter, system-ui, sans-serif'}`;
            const w = ctx.measureText(options.text).width;
            const pad = 4;
            const x = options.horizontal ? Math.min(at + 4, area.right - w - pad * 2) : area.right - w - pad * 2;
            // Vertical line: label just above the plot when there's room, so it never covers a bar.
            const y = options.horizontal ? (area.top >= 18 ? area.top - 17 : area.top + 2) : Math.max(area.top, at - 18);
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.12;
            ctx.fillRect(x, y, w + pad * 2, 16);
            ctx.globalAlpha = 1;
            ctx.textBaseline = 'middle';
            ctx.fillText(options.text, x + pad, y + 8);
        }
        ctx.restore();
    },
};
