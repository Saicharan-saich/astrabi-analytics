/**
 * AI Visual Interpreter Service
 * 
 * CRITICAL SECURITY CONSTRAINT:
 * This service ONLY receives a rendered chart IMAGE (base64 PNG).
 * It has ZERO access to raw data, uploaded files, connected databases, SQL, or dataset rows.
 * The AI model interprets purely what it sees in the visual.
 */

import { fetchWithFallback, API_KEY } from './ai-sql/modelConfig';

const TIMEOUT_MS = 20000;

// Simple cache to avoid redundant API calls for the same chart
const insightCache = new Map<string, string>();
const MAX_CACHE_SIZE = 50;

// Rate limiting (Fix #18: prevent rapid API credit burn)
let lastRequestTime = 0;
let requestCount = 0;
let requestWindowStart = 0;
const MIN_INTERVAL_MS = 2000;  // 2 second debounce
const MAX_REQUESTS_PER_MINUTE = 10;

/**
 * Generate a short hash for cache keying (from base64 image)
 */
function quickHash(str: string): string {
    let hash = 0;
    const sample = str.slice(0, 2000) + str.slice(-2000); // Sample start+end for speed
    for (let i = 0; i < sample.length; i++) {
        const char = sample.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash.toString(36);
}

/**
 * Capture a chart canvas element as a base64 PNG.
 * This is the ONLY data the AI ever sees — a rendered image.
 */
export function captureChartAsImage(chartContainer: HTMLElement): string | null {
    // Try to find a canvas element (Chart.js renders to canvas)
    const canvas = chartContainer.querySelector('canvas');
    if (!canvas) return null;

    try {
        return canvas.toDataURL('image/png');
    } catch (err) {
        console.warn('[AI Service] Failed to capture chart canvas:', err);
        return null;
    }
}

/**
 * Interpret a chart visual using AI.
 * 
 * @param chartImageBase64 - The chart rendered as a base64 PNG data URL
 * @param chartTitle - The title/label shown on the chart (visual context only)
 * @returns AI-generated interpretation string
 * 
 * SECURITY: Only the rendered image and its visible title are sent.
 * No raw data, no SQL, no dataset access.
 */
export async function interpretChartVisual(
    chartImageBase64: string,
    chartTitle?: string,
    chartContext?: {
        chartType?: string;
        xKey?: string;
        yKey?: string;
        legendLabels?: string[];
        comparisonMode?: string;
        numberFormat?: string;
    }
): Promise<string> {
    if (!API_KEY) {
        return '⚠️ Smart Insight is not configured. Please add your OpenRouter API key to the environment variables.';
    }

    if (!chartImageBase64) {
        return '⚠️ No chart visual available to interpret. Please generate a chart first.';
    }

    // Rate limiting enforcement
    const now = Date.now();
    if (now - lastRequestTime < MIN_INTERVAL_MS) {
        return '⏳ Please wait a moment before requesting another insight.';
    }
    // Reset window every minute
    if (now - requestWindowStart > 60000) {
        requestCount = 0;
        requestWindowStart = now;
    }
    if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
        return '⚠️ Insight rate limit reached. Please wait a minute before trying again.';
    }
    lastRequestTime = now;
    requestCount++;

    // Check cache
    const cacheKey = quickHash(chartImageBase64 + (chartTitle || '') + JSON.stringify(chartContext || {}));
    const cached = insightCache.get(cacheKey);
    if (cached) return cached;

    // Build contextual metadata to help the LLM understand the chart
    let contextHint = '';
    if (chartContext) {
        const parts: string[] = [];
        if (chartContext.chartType) parts.push(`Chart type: ${chartContext.chartType}`);
        if (chartContext.xKey) parts.push(`X-axis: ${chartContext.xKey}`);
        if (chartContext.yKey) parts.push(`Y-axis metric: ${chartContext.yKey}`);
        if (chartContext.legendLabels?.length) parts.push(`Legend labels: ${chartContext.legendLabels.join(', ')}`);
        if (chartContext.comparisonMode) parts.push(`Comparison mode: ${chartContext.comparisonMode}`);
        if (chartContext.numberFormat) parts.push(`Number format: ${chartContext.numberFormat}`);
        if (parts.length > 0) {
            contextHint = '\n\nChart metadata (use this to understand the chart correctly):\n' + parts.join('\n');
        }
    }

    // Build the vision prompt — business-focused diagnostic analysis
    const systemPrompt = `You are a senior business intelligence analyst interpreting a chart visual. You can ONLY see the chart image provided — no raw data access.

Your analysis must be CONCISE, ACTIONABLE, and DIAGNOSTIC. Follow this exact structure:

**📊 Quick Verdict** (1 sentence — the single most important takeaway)

**🔍 Key Findings** (3-4 bullet points, be specific with numbers you see)
- Focus on: trends, spikes, drops, outliers, comparisons
- Quantify differences (e.g., "X is 2.3x higher than Y")
- Flag anything unusual with ⚠️

**⚠️ Anomalies & Red Flags** (only if you spot something unusual)
- What looks abnormal and why it matters
- Possible root causes to investigate (think like a business analyst)

**💡 Recommended Actions** (2-3 concrete business actions)
- What should the business DO based on this visual?
- Think: pricing, inventory, marketing, staffing, cost control
- Be specific (e.g., "Investigate why December dropped 32% — check for supply chain issues or seasonal demand shift")

**🔎 Dig Deeper** (suggest 2-3 follow-up analyses)
- What questions should they ask next?
- What other data cuts would reveal root causes?
- Example: "Break this down by region to find which area drove the spike"

Rules:
- Be DIRECT — no filler phrases like "This chart shows..." 
- Use bullet points, not paragraphs
- Bold key numbers and percentages
- Keep total response under 250 words
- Think like a consultant presenting to a CEO`;

    const userContent: any[] = [
        {
            type: 'image_url',
            image_url: { url: chartImageBase64 }
        }
    ];

    const contextText = chartTitle
        ? `Chart: "${chartTitle}".${contextHint}\n\nAnalyze this visual — focus on business impact, anomalies, and what to do next.`
        : `${contextHint ? contextHint + '\n\n' : ''}Analyze this chart visual — focus on business impact, anomalies, and what to do next.`;

    userContent.unshift({ type: 'text', text: contextText });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const { data } = await fetchWithFallback(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            { temperature: 0.4, max_tokens: 800, timeout: TIMEOUT_MS }
        );

        const insight = data?.choices?.[0]?.message?.content || '⚠️ No interpretation was generated.';

        // Cache the result
        if (insightCache.size >= MAX_CACHE_SIZE) {
            // Remove oldest entry
            const firstKey = insightCache.keys().next().value;
            if (firstKey) insightCache.delete(firstKey);
        }
        insightCache.set(cacheKey, insight);

        return insight;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            return '⚠️ Insight request timed out. Please try again.';
        }
        console.error('[AI Service] Request failed:', err);
        return '⚠️ Failed to connect to insight service. Please check your internet connection.';
    }
}

/**
 * Clear the insight cache (e.g., when switching datasets)
 */
export function clearInsightCache(): void {
    insightCache.clear();
}
