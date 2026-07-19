/**
 * etlStepGuide.ts — plain-English explanations for every ETL step, written for
 * NON-TECHNICAL users. Pure UI content (no logic): for each cleaning step we say
 * what it does, why it matters for their data, what goes wrong if it's skipped,
 * and a tiny concrete example. Matched to a log by keyword so dynamic step names
 * (e.g. "Transform: PARSE_NUMBER(locale-aware)") still resolve.
 */

export interface StepGuide {
    emoji: string;
    /** Friendly, human title (the raw step name is shown as a sub-label). */
    title: string;
    /** What this step does, in one plain sentence. */
    what: string;
    /** Why it matters for getting correct numbers/insights. */
    why: string;
    /** What problem it causes if it were NOT applied. */
    ifSkipped: string;
    /** A tiny before → after example. */
    example: string;
}

// Ordered rules — the first whose pattern matches the step name wins.
const RULES: Array<{ test: RegExp; guide: StepGuide }> = [
    {
        test: /header|column name/i,
        guide: {
            emoji: '🏷️', title: 'Tidy up the column headings',
            what: 'Cleans messy column titles — trims spaces, fixes casing, and removes odd characters.',
            why: 'Clean headings let every later step (and every question you ask) reliably find the right column.',
            ifSkipped: 'Columns like "  Order Date " and "order_date" get treated as different fields, breaking filters and charts.',
            example: '"  Sale Amount " → "Sale Amount"',
        },
    },
    {
        test: /merge name/i,
        guide: {
            emoji: '🔗', title: 'Combine split name columns',
            what: 'Joins separate "First Name" and "Last Name" columns into one full name where it makes sense.',
            why: 'A single name field is easier to group, count, and display than two half-columns.',
            ifSkipped: 'You could only ever analyse first names and last names separately — never the whole person.',
            example: '"Jane" + "Doe" → "Jane Doe"',
        },
    },
    {
        test: /duplicate column/i,
        guide: {
            emoji: '🗂️', title: 'Remove repeated columns',
            what: 'Deletes columns that are exact copies of another column.',
            why: 'Duplicate columns waste space and can make the same value get counted twice.',
            ifSkipped: 'A metric stored in two identical columns can be double-counted in totals.',
            example: 'Drops "Price (copy)" when it equals "Price"',
        },
    },
    {
        test: /empty column/i,
        guide: {
            emoji: '🧹', title: 'Drop blank columns',
            what: 'Removes columns that are completely empty.',
            why: 'Empty columns add clutter and can confuse automatic chart and question suggestions.',
            ifSkipped: 'Your field list fills with useless empty columns, hiding the ones that matter.',
            example: 'Removes a "Notes" column with no values at all',
        },
    },
    {
        test: /empty row/i,
        guide: {
            emoji: '➖', title: 'Remove blank rows',
            what: 'Deletes rows that have no data in them.',
            why: 'Blank rows inflate your record count and drag averages toward zero.',
            ifSkipped: '"How many orders?" returns a number bigger than your real orders.',
            example: 'Removes 12 completely empty rows',
        },
    },
    {
        test: /duplicate row/i,
        guide: {
            emoji: '👯', title: 'Remove duplicate records',
            what: 'Deletes rows that are exact repeats of another row (same ID).',
            why: 'Duplicates inflate counts and sums — the classic cause of "the numbers look too high".',
            ifSkipped: 'One order entered twice is counted as two, overstating revenue and volume.',
            example: 'Removes a second copy of order #10231',
        },
    },
    {
        test: /whitespace/i,
        guide: {
            emoji: '✂️', title: 'Trim hidden spaces',
            what: 'Removes leading/trailing spaces and collapses double spaces inside text.',
            why: 'Hidden spaces make identical values look different, splitting one category into several.',
            ifSkipped: '"North" and "North " show up as two separate regions in every breakdown.',
            example: '"North " → "North"',
        },
    },
    {
        test: /null token/i,
        guide: {
            emoji: '🕳️', title: 'Standardize "missing" markers',
            what: 'Turns text placeholders like "N/A", "-", "unknown", "#REF!" into a proper empty value.',
            why: 'So missing data is treated as missing — not as a real category or a number.',
            ifSkipped: '"N/A" gets counted as its own group, or blocks a column from being read as numbers.',
            example: '"N/A" → (empty)',
        },
    },
    {
        test: /classification|column type/i,
        guide: {
            emoji: '🧭', title: 'Figure out what each column is',
            what: 'Labels every column as a measure (to add up), a category (to group by), a date, or an ID.',
            why: 'This is the foundation of correct math — it decides what can be summed, averaged, or grouped.',
            ifSkipped: 'The app might try to sum ID numbers or average a category — producing nonsense.',
            example: 'salary → Measure · region → Category · order_id → ID',
        },
    },
    {
        test: /transform plan/i,
        guide: {
            emoji: '📋', title: 'Plan each column\'s cleanup',
            what: 'Lists the exact sequence of cleaning steps chosen for every column.',
            why: 'Transparency — you can see precisely what was done to each field, and why.',
            ifSkipped: 'Cleaning would be a black box you couldn\'t inspect or trust.',
            example: 'price → remove "$" → convert to number',
        },
    },
    {
        test: /parse_number|word_to_number|to number/i,
        guide: {
            emoji: '🔢', title: 'Convert text into real numbers',
            what: 'Turns number-like text (currency, percentages, "1.2K", European decimals) into actual numbers.',
            why: 'Only real numbers can be summed and averaged correctly; number-shaped text cannot.',
            ifSkipped: '"$1,200" stays as text and is silently dropped from every total.',
            example: '"€1.234,56" → 1234.56',
        },
    },
    {
        test: /parse_date|date\(/i,
        guide: {
            emoji: '📅', title: 'Understand the dates',
            what: 'Reads many date formats into one standard form, and works out day-vs-month order.',
            why: 'Correct dates power every trend, "this month", and year-over-year comparison.',
            ifSkipped: 'Trends break, and 03/04 could be read as the wrong month entirely.',
            example: '"7-Mar-24" → 2024-03-07',
        },
    },
    {
        test: /title_case|casing|normalize category|synonym/i,
        guide: {
            emoji: '🔤', title: 'Standardize category spellings',
            what: 'Makes category text consistent (casing) and maps known synonyms to one form.',
            why: 'So the same thing is grouped together instead of split across spellings.',
            ifSkipped: '"USA", "usa" and "U.S.A." appear as three different countries in a chart.',
            example: '"usa" → "USA"',
        },
    },
    {
        test: /canonical/i,
        guide: {
            emoji: '🧩', title: 'Merge spelling variants',
            what: 'Combines values that are the same apart from spacing, punctuation, or accents.',
            why: 'Prevents one real category from being scattered across near-identical labels.',
            ifSkipped: '"New York", "new-york" and "New  York" split one city into three.',
            example: '"new-york" → "New York"',
        },
    },
    {
        test: /impute|missing value|fill/i,
        guide: {
            emoji: '⬜', title: 'Handle the blanks',
            what: 'Marks empty category cells as "Unknown" (numbers are left blank, never invented).',
            why: 'Keeps groupings honest without fabricating numbers that would distort totals.',
            ifSkipped: 'Blank categories vanish from breakdowns, hiding part of your data.',
            example: '(empty region) → "Unknown"',
        },
    },
    {
        test: /currency/i,
        guide: {
            emoji: '💲', title: 'Strip currency symbols',
            what: 'Removes symbols like $, €, £ so the value becomes a clean number.',
            why: 'A number wearing a currency symbol is text — it can\'t be added up.',
            ifSkipped: '"$500" is treated as a word and dropped from revenue totals.',
            example: '"$500" → 500',
        },
    },
    {
        test: /boolean|yes\/no/i,
        guide: {
            emoji: '✅', title: 'Standardize yes/no values',
            what: 'Turns Y/N, 1/0, true/false and similar into one consistent True/False.',
            why: 'Consistent flags make counts like "how many active?" reliable.',
            ifSkipped: '"Y", "yes" and "1" get counted as three different answers.',
            example: '"Y" → True',
        },
    },
    {
        test: /leading-zero|cast_id|clean id/i,
        guide: {
            emoji: '🔑', title: 'Protect codes & IDs',
            what: 'Keeps identifiers as text and preserves leading zeros instead of treating them as maths.',
            why: 'Codes like zip codes and SKUs must stay exact — and must never be summed.',
            ifSkipped: 'Zip "01234" becomes "1234", and ID numbers get added up into a meaningless total.',
            example: '"01234" stays "01234" (not 1234)',
        },
    },
    {
        test: /outlier/i,
        guide: {
            emoji: '📈', title: 'Flag extreme values',
            what: 'Highlights values far outside the normal range — a likely typo or data-entry slip.',
            why: 'A single fat-fingered value can wreck an average or total. We flag it, never delete it.',
            ifSkipped: 'One salary of 99,999,999 quietly doubles your "average salary".',
            example: 'Flags 9,999,999 among values near 50,000',
        },
    },
    {
        test: /coercion loss/i,
        guide: {
            emoji: '⚠️', title: 'Values that couldn\'t be read',
            what: 'Flags real entries in a number column that couldn\'t be understood as numbers.',
            why: 'These are silently dropped from sums/averages — you should know they exist.',
            ifSkipped: '"approx 500" is ignored, and your total is quietly too low.',
            example: 'Flags "1-2" and "approx 500" in an amount column',
        },
    },
    {
        test: /typo|near-duplicate/i,
        guide: {
            emoji: '🔍', title: 'Possible typos',
            what: 'Points out category values that look like misspellings of each other.',
            why: 'Typos split one group in two. We flag them for you to confirm — we don\'t auto-merge.',
            ifSkipped: '"Cardiology" and "Cardilogy" show as two departments.',
            example: 'Flags "Cardilogy" ≈ "Cardiology"',
        },
    },
    {
        test: /sign anomaly/i,
        guide: {
            emoji: '➖', title: 'Unexpected negative values',
            what: 'Flags negative numbers in a column that should only be positive (price, quantity, age).',
            why: 'A stray negative can silently pull a total down.',
            ifSkipped: 'A "-5" quantity subtracts from your real totals unnoticed.',
            example: 'Flags quantity = −4',
        },
    },
    {
        test: /range anomaly|mixed scale/i,
        guide: {
            emoji: '📏', title: 'Values on the wrong scale',
            what: 'Flags out-of-range values (a percentage over 100, an age of 199) or mixed 0–1 / 0–100 scales.',
            why: 'Mixed scales make an average meaningless (0.45 and 45 can\'t be averaged together).',
            ifSkipped: 'Your "average conversion rate" is a nonsense number.',
            example: 'Flags 45 mixed with 0.45 in one rate column',
        },
    },
    {
        test: /multi-value/i,
        guide: {
            emoji: '🧷', title: 'Multiple values in one cell',
            what: 'Flags cells that pack several values behind a separator like ";".',
            why: 'They can\'t be grouped correctly until they\'re split into their own rows or columns.',
            ifSkipped: '"red; blue" counts as its own category instead of two colours.',
            example: 'Flags "red; blue; green" in one cell',
        },
    },
    {
        test: /ambiguous date|date order/i,
        guide: {
            emoji: '📆', title: 'Date questions to confirm',
            what: 'Flags dates where day-vs-month order is uncertain, or an end-date lands before its start.',
            why: 'The wrong interpretation shifts every monthly figure; reversed dates are entry errors.',
            ifSkipped: 'Your monthly trend could be built on the wrong months.',
            example: 'Flags 03/04 (is it Mar 4 or Apr 3?)',
        },
    },
    {
        test: /missing data/i,
        guide: {
            emoji: '🫥', title: 'Columns with lots of gaps',
            what: 'Flags columns where a large share of values are missing.',
            why: 'An average over a half-empty column only reflects the rows that had data.',
            ifSkipped: 'You trust an "average" that quietly ignores 40% of your records.',
            example: 'Flags a column that is 40% empty',
        },
    },
    {
        test: /contract|validation/i,
        guide: {
            emoji: '🛡️', title: 'Final quality check',
            what: 'Verifies the cleaned data meets basic guarantees before analysis begins.',
            why: 'A last safety net so problems are caught here, not inside a chart.',
            ifSkipped: 'Bad data slips through to your dashboards unnoticed.',
            example: 'Confirms every number column is truly numeric',
        },
    },
    {
        test: /dimdate|date table/i,
        guide: {
            emoji: '🗓️', title: 'Build a calendar helper',
            what: 'Creates a supporting calendar table spanning your data\'s date range.',
            why: 'Powers time features like weekdays, months, quarters, and fiscal periods.',
            ifSkipped: 'Rich time analysis (by weekday, by quarter) wouldn\'t be available.',
            example: 'Generates dates from your first to last record',
        },
    },
    {
        test: /time context/i,
        guide: {
            emoji: '⏱️', title: 'Anchor "today" for the data',
            what: 'Works out the dataset\'s own date range so "this month" means the data\'s latest month.',
            why: 'Time questions answer relative to your data, not the real-world calendar.',
            ifSkipped: '"This year" could return nothing if the data isn\'t from the current year.',
            example: 'Latest record → the reference "today"',
        },
    },
    {
        test: /final summary/i,
        guide: {
            emoji: '🎉', title: 'All done — summary',
            what: 'A recap of everything the pipeline cleaned, kept, and flagged.',
            why: 'Your at-a-glance record of how the data got from raw to ready.',
            ifSkipped: 'You\'d have no single overview of what happened.',
            example: 'Clean rows, quality score, and contract status',
        },
    },
];

const GENERIC: StepGuide = {
    emoji: '⚙️', title: 'Cleaning step',
    what: 'A processing step applied to prepare your data for accurate analysis.',
    why: 'Every step moves the data closer to producing correct, trustworthy numbers.',
    ifSkipped: 'The data could carry small inconsistencies into your results.',
    example: 'See the technical details for specifics.',
};

/** Resolve the friendly guide for a step by its (possibly dynamic) name. */
export function getStepGuide(step: string): StepGuide {
    for (const r of RULES) if (r.test.test(step)) return r.guide;
    return GENERIC;
}
