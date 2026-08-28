/**
 * Privacy-safe natural-number parsing for query cardinality. This deliberately
 * handles only positive analytical limits (1..100); it never inspects data.
 */

const SMALL: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90,
};

const NUMBER_TOKEN = '(?:\\d+|one(?:\\s+hundred)?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s]+(?:one|two|three|four|five|six|seven|eight|nine))?)';

export function parseQueryNumber(value: string): number | undefined {
    const normalized = value.toLowerCase().trim().replace(/-/g, ' ').replace(/\s+/g, ' ');
    if (/^\d+$/.test(normalized)) {
        const parsed = Number(normalized);
        return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
    }
    if (normalized === 'one hundred') return 100;
    if (SMALL[normalized] !== undefined) return SMALL[normalized];
    const parts = normalized.split(' ');
    if (parts.length === 2 && TENS[parts[0]] !== undefined && SMALL[parts[1]] !== undefined) {
        return TENS[parts[0]] + SMALL[parts[1]];
    }
    if (TENS[normalized] !== undefined) return TENS[normalized];
    return undefined;
}

export interface RequestedLimit {
    limit: number;
    directionHint?: 'asc' | 'desc';
    source: string;
    placement: 'rank_prefix' | 'leading_count';
}

/** Extract “top five”, “bottom 10”, and “which five customers …”. */
export function detectRequestedLimit(question: string): RequestedLimit | undefined {
    const ranked = new RegExp(`\\b(top|bottom|first|last)\\s+(${NUMBER_TOKEN})\\b`, 'i').exec(question);
    if (ranked) {
        const limit = parseQueryNumber(ranked[2]);
        if (limit !== undefined) {
            return {
                limit,
                directionHint: /^(?:bottom|last)$/i.test(ranked[1]) ? 'asc' : 'desc',
                source: ranked[0],
                placement: 'rank_prefix',
            };
        }
    }

    const leading = new RegExp(
        `^\\s*(?:please\\s+)?(?:which|what|show|list|find|return|give(?:\\s+me)?)\\s+(?:the\\s+)?(${NUMBER_TOKEN})\\s+[a-z]`,
        'i',
    ).exec(question);
    if (!leading) return undefined;
    const limit = parseQueryNumber(leading[1]);
    return limit === undefined
        ? undefined
        : { limit, source: leading[0].trim(), placement: 'leading_count' };
}
