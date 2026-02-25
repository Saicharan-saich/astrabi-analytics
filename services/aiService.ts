/**
 * AI Visual Interpreter Service
 * 
 * CRITICAL SECURITY CONSTRAINT:
 * This service ONLY receives a rendered chart IMAGE (base64 PNG).
 * It has ZERO access to raw data, uploaded files, connected databases, SQL, or dataset rows.
 * The AI model interprets purely what it sees in the visual.
 */

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '';
const MODEL = 'google/gemini-2.0-flash-001'; // Vision-capable, fast, cost-effective
const TIMEOUT_MS = 20000;

// Simple cache to avoid redundant API calls for the same chart
const insightCache = new Map<string, string>();
const MAX_CACHE_SIZE = 50;

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
    chartTitle?: string
): Promise<string> {
    if (!API_KEY) {
        return '⚠️ Smart Insight is not configured. Please add your OpenRouter API key to the environment variables.';
    }

    if (!chartImageBase64) {
        return '⚠️ No chart visual available to interpret. Please generate a chart first.';
    }

    // Check cache
    const cacheKey = quickHash(chartImageBase64 + (chartTitle || ''));
    const cached = insightCache.get(cacheKey);
    if (cached) return cached;

    // Build the vision prompt — ONLY references what's visible in the image
    const systemPrompt = `You are a data visualization interpreter. You can ONLY see the chart image provided. 
You have NO access to any underlying data, databases, or raw numbers beyond what is visually displayed in the chart.

Provide a clear, concise interpretation of what the chart shows:
1. What type of chart is this (bar, line, pie, etc.)?
2. What are the key visual patterns, trends, or outliers?
3. What is the main takeaway a business user should understand?
4. Any notable data points that stand out visually?

Keep your response under 200 words. Use bullet points for clarity. Be direct and actionable.`;

    const userContent: any[] = [
        {
            type: 'image_url',
            image_url: { url: chartImageBase64 }
        }
    ];

    if (chartTitle) {
        userContent.unshift({
            type: 'text',
            text: `The chart is titled: "${chartTitle}". Interpret only what you see in this visualization.`
        });
    } else {
        userContent.unshift({
            type: 'text',
            text: 'Interpret only what you see in this chart visualization.'
        });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Astrabi Analytics'
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent }
                ],
                max_tokens: 500,
                temperature: 0.3  // Lower temperature for factual interpretation
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            console.error('[AI Service] API error:', response.status, errorText);
            return `⚠️ Insight service returned an error (${response.status}). Please try again.`;
        }

        const data = await response.json();
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
