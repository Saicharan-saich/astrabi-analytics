/**
 * Axis and value-label helpers. Pure functions so they can be unit tested
 * without a canvas; the chart passes in a real text measurer.
 */

export type Measure = (text: string) => number;

const ELLIPSIS = '…';

/** A rough measure for when no canvas is available (tests, SSR). */
export const approximateMeasure = (fontSize: number): Measure => text => text.length * fontSize * 0.56;

let measureCanvas: CanvasRenderingContext2D | null | undefined;

/** Measures text in the given CSS font using a shared offscreen canvas. */
export function canvasMeasure(font: string, fallbackSize = 12): Measure {
    if (measureCanvas === undefined) {
        measureCanvas = typeof document !== 'undefined'
            ? document.createElement('canvas').getContext('2d')
            : null;
    }
    const context = measureCanvas;
    if (!context) return approximateMeasure(fallbackSize);
    return text => {
        context.font = font;
        return context.measureText(text).width;
    };
}

/** Shorten text with an ellipsis until it fits. */
export function truncateToWidth(text: string, maxWidth: number, measure: Measure): string {
    if (measure(text) <= maxWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (measure(text.slice(0, mid).trimEnd() + ELLIPSIS) <= maxWidth) low = mid;
        else high = mid - 1;
    }
    return low <= 0 ? ELLIPSIS : text.slice(0, low).trimEnd() + ELLIPSIS;
}

/**
 * Fit a category name into a slot: keep it on one line when it fits,
 * otherwise wrap at spaces/hyphens onto up to `maxLines` lines, and shorten
 * the last line with an ellipsis. Returns a string or an array of lines
 * (Chart.js draws an array as multi-line tick text).
 */
export function fitAxisLabel(label: unknown, maxWidth: number, measure: Measure, maxLines = 2): string | string[] {
    const text = String(label ?? '').replace(/\s+/g, ' ').trim();
    if (!text || maxWidth <= 0) return text;
    if (measure(text) <= maxWidth) return text;
    if (maxLines <= 1) return truncateToWidth(text, maxWidth, measure);

    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (let i = 0; i < words.length; i++) {
        const candidate = current ? `${current} ${words[i]}` : words[i];
        if (!current || measure(candidate) <= maxWidth) {
            current = candidate;
            continue;
        }
        lines.push(current);
        if (lines.length === maxLines - 1) {
            // Everything left goes on the last line.
            current = words.slice(i).join(' ');
            break;
        }
        current = words[i];
    }
    if (current) lines.push(current);
    const fitted = lines.map(line => truncateToWidth(line, maxWidth, measure));
    return fitted.length === 1 ? fitted[0] : fitted;
}

// ── Colour contrast for labels drawn on top of a bar ─────────────────

function parseColour(colour: string): [number, number, number] | null {
    const value = colour.trim().toLowerCase();
    const hex = value.match(/^#([0-9a-f]{3,8})$/);
    if (hex) {
        let digits = hex[1];
        if (digits.length === 3 || digits.length === 4) digits = digits.split('').map(d => d + d).join('');
        return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
    }
    const rgb = value.match(/^rgba?\(([^)]+)\)$/);
    if (rgb) {
        const [r, g, b] = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if ([r, g, b].every(Number.isFinite)) return [r, g, b];
    }
    return null;
}

function luminance([r, g, b]: [number, number, number]): number {
    const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Dark or light ink, whichever reads better on the given fill colour. */
export function readableInkOn(fill: unknown, dark = '#111827', light = '#ffffff'): string | null {
    if (typeof fill !== 'string') return null;
    const rgb = parseColour(fill);
    if (!rgb) return null;
    const l = luminance(rgb);
    const contrastWithLight = 1.05 / (l + 0.05);
    const contrastWithDark = (l + 0.05) / (luminance(parseColour(dark) || [17, 24, 39]) + 0.05);
    return contrastWithDark >= contrastWithLight ? dark : light;
}
