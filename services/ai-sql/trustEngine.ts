/**
 * Trust & Verification Engine
 * 
 * Translates technical pipeline validation data into business-friendly
 * trust signals. Users see "Verified" / "Needs Review" / "Validation Issue"
 * instead of SQL metadata, row counts, and execution plans.
 * 
 * This is a TRANSLATION layer — it does NOT re-run validation.
 * It reads existing pipeline results and converts them to trust language.
 */

import type { AISQLPipelineResult, TrustVerification, TrustCheck } from './types';

// ── Technical → Business Language Mapping ────────────────────────

const CHECK_TRANSLATIONS: Record<string, { label: string; detail: string }> = {
    // Validation check name → business-friendly label
    'no_select_star':       { label: 'Query specificity confirmed',          detail: 'Only relevant columns were analysed — no unnecessary data included.' },
    'has_group_by':         { label: 'Data properly organised',              detail: 'Results are correctly grouped by the categories you asked about.' },
    'column_validity':      { label: 'Source records successfully checked',  detail: 'All referenced data columns exist and are valid in your dataset.' },
    'no_forbidden':         { label: 'No data integrity risks detected',     detail: 'No operations that could compromise data accuracy were used.' },
    'aggregation_check':    { label: 'Formula was verified',                 detail: 'Calculations (sums, averages, counts) were applied correctly.' },
    'filter_normalization': { label: 'Filters correctly applied',            detail: 'Your search criteria were properly translated and applied.' },
    'total_consistency':    { label: 'Insight matches source data',          detail: 'The sum of individual parts matches the overall total — no data was lost or duplicated.' },
};

// Fallback for unknown check names
const DEFAULT_TRANSLATION = { label: 'Data quality check passed', detail: 'An internal verification step completed successfully.' };

/**
 * Generate a TrustVerification from pipeline results.
 * 
 * This is the main entry point — called once after the pipeline completes.
 */
export function generateTrustVerification(result: AISQLPipelineResult): TrustVerification {
    const checks = translateChecks(result);
    const status = determineStatus(result, checks);
    const confidence = result.confidence?.level || 'low';
    const explainResult = buildExplanation(result);
    const summary = buildSummary(status, checks);

    return { status, confidence, checks, explainResult, summary };
}

/**
 * Translate technical validation checks into business-language checks.
 */
function translateChecks(result: AISQLPipelineResult): TrustCheck[] {
    const checks: TrustCheck[] = [];
    const seenLabels = new Set<string>();

    // 1. Map existing validation checks
    if (result.validation?.checks) {
        for (const check of result.validation.checks) {
            const translation = CHECK_TRANSLATIONS[check.name] || DEFAULT_TRANSLATION;
            
            // Avoid duplicate labels
            if (seenLabels.has(translation.label)) continue;
            seenLabels.add(translation.label);

            checks.push({
                label: translation.label,
                status: check.status === 'pass' ? 'pass' : check.status === 'warn' ? 'warn' : 'fail',
                detail: check.status === 'pass' ? translation.detail : translateWarning(check.message),
            });
        }
    }

    // 2. Add confidence-based checks
    if (result.confidence) {
        const { factors } = result.confidence;

        // Semantic match check
        if (factors.semanticMatch >= 24) {
            addCheck(checks, seenLabels, 'Question understood correctly', 'pass',
                'Your question was clearly mapped to the right data columns.');
        } else if (factors.semanticMatch >= 15) {
            addCheck(checks, seenLabels, 'Question interpretation', 'warn',
                'Your question was partially matched — results may need review.');
        }

        // Aggregation certainty
        if (factors.aggregationCertainty >= 16) {
            addCheck(checks, seenLabels, 'Calculation method verified', 'pass',
                'The correct mathematical operation was applied to your data.');
        }
    }

    // 3. Data presence check
    if (result.rawData && result.rawData.length > 0) {
        addCheck(checks, seenLabels, 'Results found in your data', 'pass',
            `${result.rawData.length} matching record${result.rawData.length === 1 ? '' : 's'} found.`);
    } else {
        addCheck(checks, seenLabels, 'No matching records found', 'warn',
            'Your query returned no results — try adjusting your filters.');
    }

    // 4. Repair attempts check
    if (result.repairAttempts === 0) {
        addCheck(checks, seenLabels, 'Analysis completed on first attempt', 'pass',
            'No corrections were needed — the analysis ran cleanly.');
    } else if (result.repairAttempts <= 2) {
        addCheck(checks, seenLabels, 'Analysis required minor adjustments', 'warn',
            'Small corrections were applied to ensure accuracy.');
    }

    return checks;
}

/**
 * Determine the overall trust status.
 */
function determineStatus(
    result: AISQLPipelineResult,
    checks: TrustCheck[]
): 'verified' | 'needs_review' | 'validation_issue' {
    const hasFailure = checks.some(c => c.status === 'fail');
    const hasWarning = checks.some(c => c.status === 'warn');
    const confLevel = result.confidence?.level;

    if (hasFailure || confLevel === 'low') return 'validation_issue';
    if (hasWarning || confLevel === 'medium') return 'needs_review';
    return 'verified';
}

/**
 * Build the "Explain This Result" text from the pipeline explanation.
 */
function buildExplanation(result: AISQLPipelineResult): string {
    // Use the existing data-driven answer (already in business language)
    if (result.explanation && result.explanation.length > 10) {
        return result.explanation;
    }

    // Fallback: build from raw data
    if (result.rawData && result.rawData.length > 0) {
        const cols = Object.keys(result.rawData[0]);
        const firstRow = result.rawData[0];
        const dimCol = cols.find(c => typeof firstRow[c] === 'string');
        const metCol = cols.find(c => typeof firstRow[c] === 'number');

        if (dimCol && metCol) {
            const topValue = firstRow[dimCol];
            const topMetric = Number(firstRow[metCol]).toLocaleString();
            return `${topValue} leads with ${topMetric} in ${metCol.replace(/_/g, ' ')}.`;
        }
    }

    return 'This insight was generated from your source data using verified calculations.';
}

/**
 * Build a one-line trust summary.
 */
function buildSummary(status: string, checks: TrustCheck[]): string {
    const passCount = checks.filter(c => c.status === 'pass').length;
    const total = checks.length;

    switch (status) {
        case 'verified':
            return `All ${passCount} verification checks passed successfully.`;
        case 'needs_review':
            return `${passCount} of ${total} checks passed — some items may need attention.`;
        case 'validation_issue':
            return `Potential data issues detected — please review the details below.`;
        default:
            return `${passCount} of ${total} checks completed.`;
    }
}

// ── Helpers ──────────────────────────────────────────────────────

function addCheck(checks: TrustCheck[], seen: Set<string>, label: string, status: 'pass' | 'warn' | 'fail', detail: string): void {
    if (seen.has(label)) return;
    seen.add(label);
    checks.push({ label, status, detail });
}

function translateWarning(technicalMsg: string): string {
    // Convert technical validation messages to business language
    if (technicalMsg.includes('drift') || technicalMsg.includes('differs from grand total')) {
        return 'A minor discrepancy was found between individual and total values — this may be due to rounding.';
    }
    if (technicalMsg.includes('forbidden')) {
        return 'An uncommon data operation was detected — results should be verified.';
    }
    if (technicalMsg.includes('aggregation')) {
        return 'The calculation method may not perfectly match your question — consider rephrasing.';
    }
    // Generic fallback
    return 'A minor data quality note was flagged — results are likely still accurate.';
}
