import type { Page } from '@playwright/test';

/**
 * Light-mode audit: finds (1) large dark surfaces left over from the dark
 * theme and (2) text whose contrast with its background is below 2:1
 * (effectively invisible). Results are written next to the screenshots.
 */
export async function auditLightMode(page: Page, state: string) {
    return page.evaluate((stateName) => {
        const parse = (c: string) => {
            const m = c.match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const [r, g, b, a = '1'] = m[1].split(',').map(v => v.trim());
            return { r: +r, g: +g, b: +b, a: +a };
        };
        const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
            const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const visible = (el: Element) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
            for (let n: Element | null = el; n; n = n.parentElement) {
                const s = getComputedStyle(n);
                if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.25) return false;
            }
            return true;
        };
        const describe = (el: Element) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className || '').split(/\s+/).slice(0, 8).join('.')}`.slice(0, 160);
        const effectiveBg = (el: Element) => {
            for (let n: Element | null = el; n; n = n.parentElement) {
                const s = getComputedStyle(n);
                if (s.backgroundImage && s.backgroundImage !== 'none' && /gradient/.test(s.backgroundImage)) return null;
                const c = parse(s.backgroundColor);
                if (c && c.a > 0.5) return c;
            }
            return { r: 255, g: 255, b: 255, a: 1 };
        };
        const dark: any[] = [];
        const faint: any[] = [];
        for (const el of Array.from(document.body.querySelectorAll('*'))) {
            if (['SCRIPT', 'STYLE', 'CANVAS', 'IMG', 'SVG', 'VIDEO', 'PATH', 'NOSCRIPT'].includes(el.tagName.toUpperCase())) continue;
            if (!visible(el)) continue;
            const s = getComputedStyle(el);
            const bg = parse(s.backgroundColor);
            const rect = (el as HTMLElement).getBoundingClientRect();
            if (bg && bg.a > 0.6 && lum(bg) < 0.06 && rect.width * rect.height > 1500) {
                dark.push({ el: describe(el), bg: s.backgroundColor, size: `${Math.round(rect.width)}x${Math.round(rect.height)}`, text: (el.textContent || '').trim().slice(0, 40) });
            }
            const ownText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent || '').join('').trim();
            if (ownText.length > 1) {
                const fg = parse(s.color);
                const back = effectiveBg(el);
                if (fg && back) {
                    const cr = ratio(lum(fg), lum(back));
                    if (cr < 2.5) faint.push({ el: describe(el), text: ownText.slice(0, 40), color: s.color, bg: `rgb(${back.r},${back.g},${back.b})`, contrast: +cr.toFixed(2) });
                }
            }
        }
        const dedupe = (list: any[]) => [...new Map(list.map(i => [i.el + '|' + (i.text || ''), i])).values()];
        return { state: stateName, dark: dedupe(dark), faint: dedupe(faint) };
    }, state);
}
