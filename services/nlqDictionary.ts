/**
 * ═══════════════════════════════════════════════════════════════
 * NLQ DICTIONARY — Deterministic Question Matching Engine
 * ═══════════════════════════════════════════════════════════════
 *
 * Maps natural language input to one of the 82 predefined questions
 * in QUESTION_REGISTRY using:
 *   1. Keyword extraction + stop word removal
 *   2. Synonym expansion (500+ mappings)
 *   3. N-gram scoring against question fingerprints
 *   4. Ranked suggestions for low-confidence matches
 *
 * NO AI. 100% deterministic. Same input → same output every time.
 */

import { QUESTION_REGISTRY } from './questionRegistry';

// ─── TYPES ───────────────────────────────────────────────────
export interface QuestionMatch {
    questionId: string;
    question: string;
    category: string;
    score: number;       // 0-1 confidence
    matchedKeywords: string[];
}

export interface NLQMatchResult {
    bestMatch: QuestionMatch | null;
    suggestions: QuestionMatch[];
    isConfident: boolean; // score >= 0.45
    inputKeywords: string[];
}

// ─── STOP WORDS ──────────────────────────────────────────────
// These will be stripped from user input before matching
const STOP_WORDS = new Set([
    'show', 'me', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to',
    'for', 'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
    'should', 'may', 'might', 'can', 'could', 'must', 'not', 'no', 'nor',
    'but', 'yet', 'so', 'if', 'then', 'else', 'when', 'where', 'how',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'my', 'your', 'our', 'their', 'its', 'all', 'each', 'every', 'both',
    'give', 'get', 'got', 'make', 'see', 'look', 'find', 'tell', 'let',
    'per', 'also', 'just', 'only', 'very', 'really', 'please', 'i', 'we',
    'chart', 'graph', 'display', 'visualize', 'plot', 'draw', 'view',
    'data', 'result', 'results', 'report', 'analysis', 'want', 'need',
    'much', 'many', 'some', 'any', 'about', 'like', 'know', 'whats',
    "what's", 'us', 'up', 'out',
]);

// ─── SYNONYM DICTIONARY ─────────────────────────────────────
// Maps common user words/phrases to canonical keywords used in scoring
const SYNONYMS: Record<string, string[]> = {
    // ── Metrics ──
    'revenue': ['revenue', 'sales', 'income', 'turnover', 'earning', 'earnings', 'money', 'amount', 'value', 'proceeds', 'rev', 'total sales', 'gross'],
    'orders': ['orders', 'order', 'transactions', 'transaction', 'purchases', 'purchase', 'buys', 'bookings', 'booking'],
    'aov': ['aov', 'average order value', 'avg order value', 'basket size', 'avg order', 'average order', 'order value', 'mean order', 'ticket size', 'average basket', 'per order'],
    'units': ['units', 'quantity', 'items sold', 'volume', 'pieces', 'qty', 'unit', 'items', 'sold'],
    'profit': ['profit', 'margin', 'earnings', 'net', 'net revenue', 'gross profit', 'net income', 'bottom line'],
    'customers': ['customers', 'customer', 'clients', 'client', 'buyers', 'buyer', 'users', 'user', 'people', 'shoppers'],

    // ── Time Periods ──
    'today': ['today', 'today\'s', 'todays', 'current day', 'this day', 'now', 'right now'],
    'yesterday': ['yesterday', 'yesterdays', 'yesterday\'s', 'previous day', 'last day', 'day before'],
    'week': ['week', 'weekly', 'this week', 'current week', '7 days', 'seven days', 'past week', 'wk'],
    'last week': ['last week', 'previous week', 'prior week', 'past week', 'week before'],
    'month': ['month', 'monthly', 'this month', 'current month', '30 days', 'thirty days', 'mo'],
    'last month': ['last month', 'previous month', 'prior month', 'past month', 'month before'],
    'quarter': ['quarter', 'quarterly', 'this quarter', 'current quarter', 'q1', 'q2', 'q3', 'q4', 'qtr'],
    'last quarter': ['last quarter', 'previous quarter', 'prior quarter', 'past quarter', 'quarter before'],
    'year': ['year', 'yearly', 'annual', 'annually', 'this year', 'current year', 'full year', 'yr'],
    'last year': ['last year', 'previous year', 'prior year', 'past year', 'year before', 'ly'],
    'ytd': ['ytd', 'year to date', 'year-to-date', 'cumulative year', 'so far this year'],
    'mtd': ['mtd', 'month to date', 'month-to-date', 'cumulative month', 'so far this month'],
    'qtd': ['qtd', 'quarter to date', 'quarter-to-date', 'cumulative quarter', 'so far this quarter'],

    // ── Comparisons ──
    'vs': ['vs', 'versus', 'compared to', 'compare', 'comparison', 'against', 'relative to', 'compared with', 'over'],
    'growth': ['growth', 'growth rate', 'increase', 'change', 'delta', 'diff', 'difference', 'movement', 'variation', 'shift', 'up', 'down'],
    'percent': ['percent', 'percentage', '%', 'pct', 'share', 'proportion', 'ratio', 'fraction', 'portion'],

    // ── Rankings ──
    'top': ['top', 'best', 'highest', 'leading', 'biggest', 'largest', 'most', 'greatest', 'number one', '#1', 'peak', 'maximum'],
    'bottom': ['bottom', 'worst', 'lowest', 'least', 'smallest', 'fewest', 'minimum', 'weakest', 'poorest'],

    // ── Dimensions ──
    'product': ['product', 'products', 'item', 'items', 'sku', 'skus', 'merchandise', 'goods', 'thing', 'things', 'prod'],
    'category': ['category', 'categories', 'cat', 'type', 'types', 'segment', 'segments', 'group', 'groups', 'class'],
    'channel': ['channel', 'channels', 'source', 'sources', 'traffic source', 'marketing channel', 'medium', 'platform', 'origin', 'acquisition'],
    'region': ['region', 'regions', 'location', 'locations', 'area', 'areas', 'territory', 'territories', 'geo', 'geography', 'city', 'state', 'country'],

    // ── Analysis Types ──
    'trend': ['trend', 'trends', 'trending', 'over time', 'time series', 'history', 'historical', 'trajectory', 'progression', 'evolution', 'pattern'],
    'moving average': ['moving average', 'rolling average', 'ma', 'rolling', 'smoothed', 'smooth', 'averaged'],
    'running total': ['running total', 'cumulative', 'running sum', 'accumulated', 'cumulative total', 'progressive total', 'sum so far'],
    'breakdown': ['breakdown', 'broken down', 'split', 'by', 'distribution', 'composition', 'makeup', 'mix'],
    'target': ['target', 'goal', 'benchmark', 'objective', 'achievement', 'progress', 'pacing', 'on track'],
    'momentum': ['momentum', 'velocity', 'acceleration', 'gaining', 'losing', 'gaining share', 'losing share'],
    'new': ['new', 'first time', 'first-time', 'new customer', 'new customers', 'fresh', 'acquired', 'acquisition'],
};

// ─── QUESTION FINGERPRINTS ──────────────────────────────────
// For each question in the registry, extract canonical keywords
interface QuestionFingerprint {
    id: string;
    question: string;
    category: string;
    keywords: string[];    // canonical keywords from the question text
    extraKeywords: string[]; // manually added keywords for better matching
}

// Build extra keywords for each question ID for things users might say
const EXTRA_KEYWORDS: Record<string, string[]> = {
    // Daily
    'd_rev': ['revenue', 'today', 'sales', 'daily', 'how much', 'total', 'earning'],
    'd_orders': ['orders', 'today', 'how many', 'count', 'daily', 'transactions'],
    'd_aov': ['aov', 'average order value', 'today', 'basket', 'daily', 'per order'],
    'd_units': ['units', 'sold', 'today', 'quantity', 'items', 'daily', 'how many'],
    'd_vs_y_rev': ['revenue', 'vs', 'yesterday', 'compare', 'day over day', 'dod'],
    'd_vs_y_orders': ['orders', 'vs', 'yesterday', 'compare', 'day over day'],
    'd_vs_y_aov': ['aov', 'vs', 'yesterday', 'compare', 'average order'],
    'd_pct_chg_rev': ['percent', 'change', 'revenue', 'yesterday', 'growth', 'daily'],
    'd_pct_total_prod': ['percent', 'revenue', 'product', 'today', 'share', 'breakdown', 'distribution'],
    'd_pct_total_channel': ['percent', 'sales', 'channel', 'today', 'share', 'source', 'distribution'],
    'd_top_5_prod': ['top', 'product', 'today', 'best', 'selling', 'ranking'],
    'd_top_channels': ['top', 'channel', 'today', 'best', 'source', 'marketing'],
    'd_ma_7_rev': ['moving average', 'revenue', '7 day', 'seven day', 'rolling', 'weekly', 'smoothed'],
    'd_run_total_month': ['running total', 'revenue', 'mtd', 'month to date', 'cumulative'],

    // Weekly
    'w_rev': ['revenue', 'week', 'weekly', 'this week', 'sales'],
    'w_orders': ['orders', 'week', 'weekly', 'this week', 'transactions'],
    'w_aov': ['aov', 'week', 'weekly', 'this week', 'average order'],
    'w_vs_lw_rev': ['revenue', 'vs', 'last week', 'week over week', 'wow', 'compare'],
    'w_vs_lw_orders': ['orders', 'vs', 'last week', 'week over week', 'wow', 'compare'],
    'w_pct_growth_rev': ['weekly', 'revenue', 'growth', 'percent', 'change', 'wow'],
    'w_pct_growth_orders': ['weekly', 'orders', 'growth', 'percent', 'change'],
    'w_pct_total_channel': ['percent', 'revenue', 'channel', 'week', 'share', 'distribution'],
    'w_top_prod': ['top', 'product', 'week', 'best selling', 'this week', 'ranking'],
    'w_ma_4_rev': ['moving average', '4 week', 'four week', 'rolling', 'monthly', 'smoothed'],

    // Monthly
    'm_rev': ['revenue', 'month', 'monthly', 'this month', 'sales'],
    'm_orders': ['orders', 'month', 'monthly', 'this month', 'transactions'],
    'm_aov': ['aov', 'month', 'monthly', 'this month', 'average order'],
    'm_vs_lm_rev': ['revenue', 'vs', 'last month', 'month over month', 'mom', 'compare'],
    'm_vs_lm_orders': ['orders', 'vs', 'last month', 'month over month', 'mom', 'compare'],
    'm_mtd_rev': ['mtd', 'month to date', 'revenue', 'cumulative', 'so far'],
    'm_mtd_orders': ['mtd', 'month to date', 'orders', 'cumulative'],
    'm_py_mtd_rev': ['same month', 'last year', 'revenue', 'prior year', 'py', 'mtd'],
    'm_py_mtd_orders': ['same month', 'last year', 'orders', 'prior year', 'py', 'mtd'],
    'm_vs_py_mtd_rev': ['mtd', 'vs', 'last year', 'revenue', 'compare', 'prior year', 'yoy'],
    'm_vs_py_mtd_orders': ['mtd', 'vs', 'last year', 'orders', 'compare', 'prior year'],
    'm_pct_growth_rev': ['mom', 'revenue', 'growth', 'percent', 'month over month', 'change'],
    'm_pct_growth_aov': ['mom', 'aov', 'growth', 'percent', 'average order', 'change'],
    'm_pct_total_cat': ['percent', 'revenue', 'category', 'month', 'share', 'breakdown'],
    'm_top_10_prod': ['top', 'product', 'month', '10', 'best', 'selling', 'ranking'],
    'm_top_channel': ['top', 'channel', 'month', 'marketing', 'best', 'source'],
    'm_ma_3_rev': ['moving average', '3 month', 'three month', 'rolling', 'quarterly', 'smoothed'],
    'm_run_total_ytd': ['running total', 'revenue', 'ytd', 'year to date', 'cumulative'],
    'm_trend': ['trend', 'revenue', '12 months', 'monthly', 'last year', 'history', 'over time', 'time series'],

    // Quarterly
    'q_rev': ['revenue', 'quarter', 'quarterly', 'this quarter', 'sales'],
    'q_orders': ['orders', 'quarter', 'quarterly', 'this quarter', 'transactions'],
    'q_aov': ['aov', 'quarter', 'quarterly', 'this quarter', 'average order'],
    'q_vs_lq_rev': ['revenue', 'vs', 'last quarter', 'quarter over quarter', 'qoq', 'compare'],
    'q_vs_lq_orders': ['orders', 'vs', 'last quarter', 'quarter over quarter', 'qoq', 'compare'],
    'q_qtd_rev': ['qtd', 'quarter to date', 'revenue', 'cumulative'],
    'q_qtd_orders': ['qtd', 'quarter to date', 'orders', 'cumulative'],
    'q_py_qtd_rev': ['same quarter', 'last year', 'revenue', 'prior year', 'py', 'qtd'],
    'q_py_qtd_orders': ['same quarter', 'last year', 'orders', 'prior year', 'py', 'qtd'],
    'q_vs_py_qtd_rev': ['qtd', 'vs', 'last year', 'revenue', 'compare', 'prior year', 'yoy'],
    'q_vs_py_qtd_orders': ['qtd', 'vs', 'last year', 'orders', 'compare', 'prior year'],
    'q_pct_growth_rev': ['qoq', 'revenue', 'growth', 'percent', 'quarter over quarter', 'change'],
    'q_pct_growth_orders': ['qoq', 'orders', 'growth', 'percent', 'quarter over quarter', 'change'],
    'q_pct_total_cat': ['percent', 'revenue', 'product', 'quarter', 'share', 'breakdown'],
    'q_top_10_prod': ['top', 'product', 'quarter', '10', 'best', 'selling', 'ranking'],
    'q_top_channel': ['top', 'channel', 'quarter', 'best', 'source', 'marketing'],

    // Yearly
    'ytd_rev': ['revenue', 'ytd', 'year to date', 'this year', 'annual', 'total year'],
    'ytd_orders': ['orders', 'ytd', 'year to date', 'this year', 'annual', 'total year'],
    'ytd_vs_ly': ['revenue', 'this year', 'vs', 'last year', 'yoy', 'year over year', 'compare', 'annual'],
    'ytd_vs_ly_orders': ['orders', 'this year', 'vs', 'last year', 'yoy', 'year over year', 'compare'],
    'ytd_py_ytd_rev': ['prior year', 'ytd', 'revenue', 'last year', 'py'],
    'ytd_py_ytd_orders': ['prior year', 'ytd', 'orders', 'last year', 'py'],
    'ytd_vs_py_ytd_rev': ['ytd', 'vs', 'prior year', 'revenue', 'compare', 'yoy'],
    'ytd_vs_py_ytd_orders': ['ytd', 'vs', 'prior year', 'orders', 'compare', 'yoy'],
    'ytd_pct_growth': ['ytd', 'revenue', 'growth', 'percent', 'year over year', 'change'],
    'ytd_pct_growth_orders': ['ytd', 'orders', 'growth', 'percent', 'year over year', 'change'],
    'all_pct_top_10': ['percent', 'lifetime', 'top 10', 'product', 'revenue', 'share', 'all time'],
    'all_best_prod': ['best', 'product', 'all time', 'selling', 'top', 'lifetime', 'ever'],
    'all_top_cust': ['top', 'customer', 'lifetime value', 'clv', 'ltv', 'best customer', 'vip'],
    'all_ma_12_rev': ['12 month', 'rolling', 'revenue', 'moving average', 'annual', 'yearly trend'],
    'all_run_total': ['lifetime', 'running total', 'cumulative', 'all time', 'total', 'ever'],

    // Operational
    'op_track_vs_y': ['on track', 'vs yesterday', 'pacing', 'ahead', 'behind', 'today vs yesterday'],
    'op_target': ['target', 'goal', 'achievement', 'daily target', 'progress', 'benchmark', 'pacing'],
    'op_losing_mo': ['losing', 'momentum', 'declining', 'falling', 'dropping', 'week over week', 'product'],
    'op_gaining_share': ['gaining', 'share', 'growing', 'rising', 'channel', 'week over week', 'momentum'],
    'rev_30d': ['revenue', 'last 30 days', '30 day', 'thirty day', 'month', 'past month'],
    'mkt_source': ['revenue', 'traffic source', 'channel', 'source', 'marketing', 'distribution', 'breakdown'],
    'cust_new': ['new customer', 'new customers', 'today', 'first time', 'acquisition', 'new buyers'],
    'top_10_prod': ['top 10', 'product', 'all time', 'best', 'selling', 'ranking', 'ever'],
};

// ─── BUILD FINGERPRINTS ──────────────────────────────────────
function buildFingerprints(): QuestionFingerprint[] {
    return QUESTION_REGISTRY.map(q => {
        // Extract keywords from question text
        const textWords = q.question.toLowerCase()
            .replace(/[^a-z0-9\s%]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 1 && !STOP_WORDS.has(w));

        const extra = EXTRA_KEYWORDS[q.id] || [];

        return {
            id: q.id,
            question: q.question,
            category: q.category,
            keywords: textWords,
            extraKeywords: extra,
        };
    });
}

let _fingerprints: QuestionFingerprint[] | null = null;
function getFingerprints(): QuestionFingerprint[] {
    if (!_fingerprints) _fingerprints = buildFingerprints();
    return _fingerprints;
}

// ─── SYNONYM EXPANSION ──────────────────────────────────────
// Given a user word, returns all canonical forms it could represent
function expandSynonyms(word: string): string[] {
    const results: string[] = [word];
    for (const [canonical, syns] of Object.entries(SYNONYMS)) {
        if (syns.includes(word) || canonical === word) {
            results.push(canonical);
            // Also add other synonyms as potential matches
            results.push(...syns);
        }
    }
    return [...new Set(results)];
}

// ─── TOKENIZE USER INPUT ────────────────────────────────────
function tokenize(input: string): string[] {
    return input.toLowerCase()
        .replace(/[^a-z0-9\s%#]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 0);
}

function extractKeywords(tokens: string[]): string[] {
    return tokens.filter(t => !STOP_WORDS.has(t) && t.length > 1);
}

// ─── BIGRAM EXTRACTION ──────────────────────────────────────
function getBigrams(tokens: string[]): string[] {
    const bigrams: string[] = [];
    for (let i = 0; i < tokens.length - 1; i++) {
        bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return bigrams;
}

// ─── LEVENSHTEIN DISTANCE ───────────────────────────────────
function levenshtein(a: string, b: string): number {
    const m: number[][] = [];
    for (let i = 0; i <= b.length; i++) m[i] = [i];
    for (let j = 0; j <= a.length; j++) m[0][j] = j;
    for (let i = 1; i <= b.length; i++)
        for (let j = 1; j <= a.length; j++)
            m[i][j] = b[i - 1] === a[j - 1]
                ? m[i - 1][j - 1]
                : Math.min(m[i - 1][j - 1], m[i][j - 1], m[i - 1][j]) + 1;
    return m[b.length][a.length];
}

// Fuzzy match: returns 0-1 score (1 = exact match)
function fuzzyScore(a: string, b: string): number {
    if (a === b) return 1.0;
    if (a.includes(b) || b.includes(a)) return 0.85;
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    const score = 1 - (dist / maxLen);
    return score >= 0.7 ? score : 0;
}

// ─── SCORE A QUESTION AGAINST USER INPUT ────────────────────
function scoreQuestion(
    fingerprint: QuestionFingerprint,
    userKeywords: string[],
    userBigrams: string[],
    expandedUserWords: Set<string>,
    rawInput: string,
): number {
    let score = 0;
    let maxPossible = 0;

    // All target keywords = question text keywords + extra keywords
    const allTargetKeywords = [...fingerprint.keywords, ...fingerprint.extraKeywords];
    const uniqueTargets = [...new Set(allTargetKeywords)];

    // 1. Direct keyword match (highest weight)
    for (const target of uniqueTargets) {
        maxPossible += 1;
        if (expandedUserWords.has(target)) {
            score += 1;
        } else {
            // Check for fuzzy match against the user's original keywords
            let bestFuzzy = 0;
            for (const uk of userKeywords) {
                const f = fuzzyScore(uk, target);
                if (f > bestFuzzy) bestFuzzy = f;
            }
            if (bestFuzzy > 0) score += bestFuzzy * 0.7;
        }
    }

    // 2. Bigram match — catches multi-word concepts like "last week", "top 10"
    for (const target of uniqueTargets) {
        if (target.includes(' ')) {
            // It's a multi-word target
            if (userBigrams.includes(target) || rawInput.includes(target)) {
                score += 1.5; // Bonus for multi-word match
                maxPossible += 1.5;
            } else {
                maxPossible += 0.5; // Still counts a bit
            }
        }
    }

    // 3. Exact question text substring match (strong signal)
    const normalizedQ = fingerprint.question.toLowerCase();
    if (rawInput.includes(normalizedQ) || normalizedQ.includes(rawInput)) {
        score += 3;
        maxPossible += 3;
    } else {
        maxPossible += 1;
    }

    // 4. Penalize if user keywords are mostly NOT in the target
    //    (prevents broad matches where only 1 keyword matched)
    const matchedCount = userKeywords.filter(uk =>
        expandedUserWords.has(uk) && uniqueTargets.some(t =>
            t === uk || t.includes(uk) || uk.includes(t) || expandedUserWords.has(t)
        )
    ).length;

    const unmatchedUserRatio = userKeywords.length > 0
        ? 1 - (matchedCount / userKeywords.length)
        : 0;
    score *= (1 - unmatchedUserRatio * 0.3);

    // Normalize to 0-1
    return maxPossible > 0 ? Math.min(1, score / maxPossible) : 0;
}

// ─── MAIN MATCHING FUNCTION ─────────────────────────────────
export function matchQuestion(input: string): NLQMatchResult {
    if (!input || typeof input !== 'string' || input.trim().length === 0) {
        return { bestMatch: null, suggestions: [], isConfident: false, inputKeywords: [] };
    }

    const rawInput = input.toLowerCase().trim();
    const tokens = tokenize(input);
    const keywords = extractKeywords(tokens);
    const bigrams = getBigrams(tokens);

    // Expand all user keywords through synonym dictionary
    const expandedWords = new Set<string>();
    for (const kw of keywords) {
        for (const expanded of expandSynonyms(kw)) {
            expandedWords.add(expanded);
        }
    }
    // Also expand bigrams
    for (const bg of bigrams) {
        for (const expanded of expandSynonyms(bg)) {
            expandedWords.add(expanded);
        }
    }

    const fingerprints = getFingerprints();

    // Score every question
    const scored: QuestionMatch[] = fingerprints.map(fp => ({
        questionId: fp.id,
        question: fp.question,
        category: fp.category,
        score: scoreQuestion(fp, keywords, bigrams, expandedWords, rawInput),
        matchedKeywords: keywords.filter(kw =>
            [...fp.keywords, ...fp.extraKeywords].some(t =>
                t === kw || t.includes(kw) || kw.includes(t) ||
                expandSynonyms(kw).some(syn => t === syn || t.includes(syn))
            )
        ),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Filter out zero-score matches
    const nonZero = scored.filter(s => s.score > 0.05);

    const bestMatch = nonZero.length > 0 ? nonZero[0] : null;
    const isConfident = bestMatch ? bestMatch.score >= 0.45 : false;

    // Top 5 suggestions (always show, even if confident — user can choose)
    const suggestions = nonZero.slice(0, 5);

    return {
        bestMatch,
        suggestions,
        isConfident,
        inputKeywords: keywords,
    };
}

// ─── GIBBERISH DETECTION ────────────────────────────────────
// Returns true if input appears to be nonsensical
export function isGibberish(input: string): boolean {
    if (!input || input.trim().length === 0) return true;

    const tokens = tokenize(input);
    const keywords = extractKeywords(tokens);

    // If no meaningful keywords at all after stop word removal
    if (keywords.length === 0) return true;

    // If all tokens are very short (likely random chars)
    if (tokens.every(t => t.length <= 2)) return true;

    // Check if any keyword matches any synonym (even loosely)
    let anyRecognized = false;
    for (const kw of keywords) {
        for (const [_, syns] of Object.entries(SYNONYMS)) {
            if (syns.some(s => s.includes(kw) || kw.includes(s))) {
                anyRecognized = true;
                break;
            }
        }
        if (anyRecognized) break;
    }

    return !anyRecognized;
}
