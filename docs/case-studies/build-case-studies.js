const fs = require('fs');
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
    LevelFormat, PageBreak,
} = require('docx');

/* ── helpers ─────────────────────────────────────────────────────── */

function runs(text, opts = {}) {
    return text.split(/(\[[^\]]+\])/g).filter(Boolean).map(p =>
        p.startsWith('[')
            ? new TextRun({ text: p, highlight: 'yellow', bold: true, ...opts })
            : new TextRun({ text: p, ...opts }));
}

const p = (text, opts = {}) => new Paragraph({
    children: runs(text, opts.run || {}),
    spacing: { after: opts.after ?? 180, line: 288 },
    alignment: opts.align, indent: opts.indent,
    ...(opts.border ? { border: opts.border } : {}),
});

const h1 = text => new Paragraph({
    text, heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 },
});
const spacer = (after = 140) => new Paragraph({ text: '', spacing: { after } });

const RULE = { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 6 } };

/** Pull-quote styling for the customer's own words. */
const pullQuote = text => new Paragraph({
    children: [new TextRun({ text, italics: true, size: 26, color: '2A2A3E' })],
    spacing: { before: 160, after: 140, line: 300 },
    indent: { left: 480 },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'B0B4C0', space: 12 } },
});

function cell(text, o = {}) {
    return new TableCell({
        width: { size: o.w, type: WidthType.DXA },
        shading: o.shade ? { type: ShadingType.CLEAR, color: 'auto', fill: o.shade } : undefined,
        margins: { top: 100, bottom: 100, left: 140, right: 140 },
        verticalAlign: 'center',
        children: (Array.isArray(text) ? text : [text]).map(t => new Paragraph({
            children: runs(t, { bold: o.bold, size: 20 }),
            alignment: o.align, spacing: { after: 0, line: 260 },
        })),
    });
}

function table(widths, rows) {
    return new Table({
        columnWidths: widths,
        width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
        rows: rows.map(r => new TableRow({
            children: r.cells.map((c, i) => cell(c, {
                w: widths[i], bold: r.head || (r.boldFirst && i === 0),
                shade: r.head ? 'E8EAF0' : r.shade, align: r.align && r.align[i],
            })),
            tableHeader: !!r.head,
        })),
    });
}

const numbering = {
    config: [{
        reference: 'bullets',
        levels: [{
            level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
    }],
};

const bullet = text => new Paragraph({
    children: runs(text),
    numbering: { reference: 'bullets', level: 0 },
    spacing: { after: 110, line: 276 },
});

const baseStyles = {
    default: {
        document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 288 } } },
        heading1: { run: { font: 'Calibri', size: 26, bold: true, color: '1A1A2E' } },
        heading2: { run: { font: 'Calibri', size: 23, bold: true, color: '333344' } },
    },
};

const PAGE = { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } };

/* ── shared blocks ───────────────────────────────────────────────── */

const draftWarning = company => new Paragraph({
    children: [new TextRun({
        text: `DRAFT FOR APPROVAL — NOT YET VERIFIED. Every highlighted field must be `
            + `completed and confirmed by ${company}. This document must not be published, `
            + `submitted to any third party, or used as evidence until ${company} has approved `
            + `it in writing using the sign-off block on the last page.`,
        italics: true, size: 20, color: '8A1C1C',
    })],
    spacing: { after: 320 }, border: RULE,
});

function header(company, strapline, standfirst) {
    return [
        new Paragraph({
            children: [new TextRun({ text: 'CASE STUDY', bold: true, size: 20, color: '666677' })],
            spacing: { after: 60 },
        }),
        new Paragraph({
            children: [new TextRun({ text: company, bold: true, size: 40, color: '1A1A2E' })],
            spacing: { after: 80 },
        }),
        new Paragraph({
            children: [new TextRun({ text: strapline, size: 24, color: '444455' })],
            spacing: { after: 200 },
        }),
        new Paragraph({
            children: runs(standfirst, { size: 25, color: '2A2A3E' }),
            spacing: { after: 200, line: 300 },
        }),
        new Paragraph({ text: '', border: RULE, spacing: { after: 320 } }),
    ];
}

/** The "why not just hire someone / buy a BI tool" section — the core thesis. */
function whyNotTheUsualAnswers(company, roleDoingIt, extra) {
    return [
        h1('Why the usual answers did not fit'),
        p(`The obvious solution is to hire someone. A data analyst would have taken the reporting off `
            + `${roleDoingIt}’s desk entirely. But a salaried analyst was never realistic for a business `
            + `of ${company}’s size — the cost of the role would have been out of proportion to the `
            + `problem it solved. [ADD ${company.toUpperCase()}’S OWN WORDS ON WHY HIRING WAS NOT AN `
            + `OPTION, IF THEY ARE WILLING TO GIVE THEM.]`),
        p('The second obvious solution is a business intelligence tool. On paper these solve exactly '
            + 'this problem. In practice they move the difficulty rather than removing it: before a '
            + 'chart appears, someone has to connect the data, define how tables relate to each other, '
            + 'and build a model. That is analyst work. Buying the software does not supply the person '
            + 'who knows how to use it, and for a small team the licence cost arrives on top of a '
            + 'learning curve nobody has time for.'),
        p(extra),
        p(`So the work stayed where it was — with ${roleDoingIt}, in Excel, done by hand.`),
    ];
}

/** Product description — accurate, and framed as "what replaced the manual work". */
function whatChanged(company, whoUses, loadDescription, questions, dashboardLine) {
    return [
        h1('What changed'),
        p(`${company} started using QuickInsight in [MONTH YEAR]. It is a browser-based analysis tool `
            + `built for people who work with spreadsheets rather than for data specialists.`),
        p(loadDescription),
        p('The cleaning that used to be done by hand happens automatically when the file loads. '
            + 'QuickInsight reads the spreadsheet, works out which columns are dates and standardises '
            + 'their formats, identifies which numbers can meaningfully be added up and which cannot, '
            + 'tidies inconsistent category values so that the same thing spelled two ways is counted '
            + 'once, and flags columns that hold personal information. None of this requires a '
            + 'decision from the user.'),
        p('Questions are then asked in one of two ways. The guided question builder works by choosing '
            + 'what to break the numbers down by, which figure to measure, which rows to include and '
            + 'how to order the result — the four things every business question is made of. '
            + 'Alternatively the question can simply be typed in plain English. Either way a chart or '
            + 'table appears, with the underlying query visible for anyone who wants to check it.'),
        p(`${whoUses} now asks questions such as:`),
        ...questions.map(bullet),
        p(dashboardLine),
    ];
}

/** Privacy — demoted to a supporting benefit, which is what it is. */
function dataNote(sensitivity) {
    return [
        h1('A note on the data itself'),
        p(sensitivity),
        p('This turned out to matter more than expected. QuickInsight does its work inside the web '
            + 'browser on the user’s own computer — the spreadsheet is never uploaded to a server. '
            + 'Where the plain-English question feature is used, only the structure of the data is '
            + 'sent: table names, column names and data types. No data values are sent unless the '
            + 'user explicitly switches that on, and even then anything resembling a name, an '
            + 'identifier, contact details or a sensitive category is excluded automatically, with '
            + 'the user able to switch off any remaining column or individual value first.'),
        p('The practical effect is that adopting the tool required no data protection review, no '
            + 'supplier security assessment, and no conversation about where the data would be '
            + 'stored. [CONFIRM THIS IS ACCURATE FOR THIS CUSTOMER — DELETE IF A REVIEW WAS IN FACT '
            + 'CARRIED OUT, OR REPLACE WITH WHAT THEY DID.]'),
    ];
}

function results(company, rows) {
    return [
        h1('Results'),
        p(`[${company} to complete. Use only figures ${company} can stand behind. Delete any row that `
            + `cannot be evidenced.]`),
        table([4200, 2400, 2426], [{ head: true, cells: ['Measure', 'Before', 'After'] }, ...rows]),
        spacer(200),
        p('[ADD ANY OUTCOME THAT IS NOT A TIME SAVING — something the analysis showed that was not '
            + 'known before, or a decision made differently as a result. A specific incident is more '
            + 'persuasive than an average.]'),
    ];
}

function inTheirWords(company) {
    return [
        h1('In their words'),
        pullQuote('"[QUOTE — the customer’s own words. What the week looks like now compared with '
            + 'before, and what they would say to another small business in the same position.]"'),
        p(`— [NAME], [JOB TITLE], ${company}`, { indent: { left: 480 } }),
    ];
}

function signOff(company) {
    return [
        new Paragraph({ children: [new PageBreak()] }),
        h1('Approval'),
        p(`I confirm that the statements and figures in this case study are accurate, and I `
            + `authorise ${company} to be named, and this document to be used, in QuickInsight’s `
            + `marketing materials and in applications to funding bodies, awards and government `
            + `schemes.`),
        spacer(200),
        table([4513, 4513], [
            { head: true, cells: [`For ${company}`, ''] },
            { cells: ['Signature:', ''] },
            { cells: ['', ''] },
            { cells: ['Name:  [FULL NAME]', 'Title:  [JOB TITLE]'] },
            { cells: ['Email:  [EMAIL]', 'Phone:  [PHONE]'] },
            { cells: ['Date:', 'Company stamp (if used):'] },
        ]),
        spacer(260),
        new Paragraph({
            children: [new TextRun({
                text: 'Notes for QuickInsight — delete this section before sending',
                bold: true, size: 22, color: '8A1C1C',
            })],
            spacing: { before: 200, after: 140 },
        }),
        bullet('Do not fill in the results figures yourself. Ask the customer for them, and use their number even if it is lower than you hoped — a modest verified figure is evidence, an impressive invented one is not.'),
        bullet('If the customer cannot give a number, delete that row rather than estimating.'),
        bullet('One question gets you most of the results table: "Before QuickInsight, how often did you rebuild this and roughly how long did it take each time? And now?"'),
        bullet('The quote must be the customer’s own words. If they ask you to draft one, send it as a suggestion and let them rewrite it.'),
        bullet('Send as PDF once the placeholders are filled. Ask for a signed scan back, and keep the original.'),
    ];
}

/* ════════════════════════════════════════════════════════════════════
   1 — ClickNsend   (facts confirmed by the customer are set; the rest
                     remain placeholders)
   ════════════════════════════════════════════════════════════════════ */

const clicknsend = [
    ...header(
        'ClickNsend',
        'Logistics and parcel delivery · Aberdeen, United Kingdom',
        'A ten-person parcel company was spending around ten hours a week turning depot '
        + 'spreadsheets into figures by hand. Hiring an analyst was never on the table. This is '
        + 'what they did instead.'),
    draftWarning('ClickNsend'),

    h1('At a glance'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Sector', 'Logistics and parcel delivery'] },
        { boldFirst: true, cells: ['Location', 'Aberdeen, United Kingdom'] },
        { boldFirst: true, cells: ['Size', '10 employees'] },
        { boldFirst: true, cells: ['Using QuickInsight since', '2 July 2026'] },
        { boldFirst: true, cells: ['Used for', 'Parcel volume tracking and delivery performance analysis'] },
        { boldFirst: true, cells: ['Data source', 'Daily manifest exports from the courier platform, as Excel files'] },
    ]),

    h1('Ten people, no data team'),
    p('ClickNsend is a parcel and logistics business in Aberdeen with ten employees. Like most '
        + 'companies its size, it produces a great deal of operational data without having anyone '
        + 'whose job is to make sense of it.'),
    p('The data itself was never the problem. Manifest exports came out of the courier management '
        + 'system reliably — a spreadsheet per depot, per week. The problem was that turning those '
        + 'spreadsheets into an answer took a person, and the only person available was the '
        + 'operations manager, whose actual job is running operations.'),

    h1('What the week looked like'),
    p('Reporting was built in Excel using pivot tables, rebuilt from scratch each time somebody '
        + 'asked for a figure. Producing a single view of parcel volumes broken down by worker took '
        + 'around ten hours a week — a quarter of someone’s working time spent on spreadsheet '
        + 'mechanics rather than on the operation.'),
    p('Three things made it slower than it should have been:'),
    bullet('Date and status columns came out of the system in inconsistent formats and had to be cleaned by hand every time.'),
    bullet('Combining depots meant copying sheets together manually, which introduced errors.'),
    bullet('Only one person understood how the pivot tables were constructed, so reporting stopped when they were away.'),
    p('That last point is the one that tends to go unnoticed until it bites. The reporting was not '
        + 'just slow; it was a single point of failure sitting inside one person’s spreadsheet.'),

    ...whyNotTheUsualAnswers(
        'ClickNsend', 'the operations manager',
        'Outsourcing to a consultant was considered as a middle path, but it fits scheduled reports '
        + 'rather than the way questions actually arrive in a small business — someone asks something '
        + 'on a Tuesday afternoon and wants the answer before the end of the day. '
        + '[CONFIRM OR REPLACE WITH WHAT CLICKNSEND ACTUALLY CONSIDERED.]'),

    ...whatChanged(
        'ClickNsend', 'The operations team',
        'The manifest export is loaded straight into the browser — the same Excel file that came out '
        + 'of the courier system, with no preparation step. Nothing is installed and nothing is '
        + 'configured first.',
        [
            '[QUESTION 1 — e.g. parcel volume by depot, by week]',
            '[QUESTION 2 — e.g. failed delivery rate by postcode area]',
            '[QUESTION 3 — e.g. average parcels per driver per day, ranked highest first]',
            '[QUESTION 4 — e.g. week-on-week change in volume by service tier]',
        ],
        'The answers that get asked for repeatedly are saved to a dashboard, so the next time the '
        + 'question comes up it does not need rebuilding at all. [WHO] reviews it [HOW OFTEN].'),

    ...dataNote(
        'Parcel manifests contain recipient names, delivery addresses and contact telephone '
        + 'numbers — the personal data of every person ClickNsend delivers to.'),

    ...results('ClickNsend', [
        { cells: ['Time spent on parcel volume reporting', '10 hours per week', '[N] [minutes / hours] per week'] },
        { cells: ['People able to produce the figures', '1', '[N]'] },
        { cells: ['Wait for an ad-hoc question to be answered', '[e.g. next day]', '[e.g. minutes]'] },
        { cells: ['[OTHER MEASURE]', '[VALUE]', '[VALUE]'] },
    ]),

    ...inTheirWords('ClickNsend'),
    ...signOff('ClickNsend'),
];

/* ════════════════════════════════════════════════════════════════════
   2 — Nithyasystems
   ════════════════════════════════════════════════════════════════════ */

const nithya = [
    ...header(
        'Nithyasystems',
        'Software services · [CITY], [COUNTRY]',
        'Contracts in one spreadsheet, budgets in another, actuals in a third — and nobody whose '
        + 'job it was to reconcile them. [N] hours of manual matching became a question anyone could '
        + 'ask.'),
    draftWarning('Nithyasystems'),

    h1('At a glance'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Sector', 'Software services'] },
        { boldFirst: true, cells: ['Location', '[CITY], [COUNTRY]'] },
        { boldFirst: true, cells: ['Size', '[N] employees'] },
        { boldFirst: true, cells: ['Using QuickInsight since', '[MONTH YEAR]'] },
        { boldFirst: true, cells: ['Used for', 'Contract management and budget tracking'] },
        { boldFirst: true, cells: ['Data source', '[DESCRIBE — e.g. a contract register spreadsheet plus monthly actuals exported from the accounting system]'] },
    ]),

    h1('A finance question nobody had time to answer'),
    p('Nithyasystems is a software services business with [N] employees. Its client work is '
        + 'organised around contracts, each with a budget attached, and the money against those '
        + 'budgets is spent month by month.'),
    p('Keeping track of that meant [DESCRIBE — e.g. three separate spreadsheets maintained by '
        + 'different people: a contract register, a budget sheet, and a monthly actuals export from '
        + 'the accounting system]. Each one was accurate on its own. The difficulty was that the '
        + 'useful questions all required two of them at once.'),

    h1('What the work looked like'),
    p('Answering something as basic as "which contracts are over budget this quarter" meant matching '
        + 'contract references between sheets by hand, usually with VLOOKUP. It took roughly [N] '
        + 'hours, and it had to be redone from the beginning whenever the actuals were updated.'),
    p('The recurring problems were:'),
    bullet('[DIFFICULTY 1 — e.g. contract references were formatted differently in each sheet, so lookups silently failed and the mismatch was only noticed later]'),
    bullet('[DIFFICULTY 2 — e.g. budgets and actuals were never reconciled between quarter ends, so overruns surfaced late]'),
    bullet('[DIFFICULTY 3 — e.g. there was no reliable view of total committed spend across all live contracts]'),
    p('Because the exercise was expensive, it was done rarely. And because it was done rarely, '
        + 'problems were found at the point where they were hardest to do anything about.'),

    ...whyNotTheUsualAnswers(
        'Nithyasystems', '[ROLE — e.g. the finance lead]',
        'Asking the accountant to produce the analysis was possible but slow and billed by the hour, '
        + 'and it produced a report rather than the ability to ask a follow-up question. '
        + '[CONFIRM OR REPLACE WITH WHAT NITHYASYSTEMS ACTUALLY CONSIDERED.]'),

    ...whatChanged(
        'Nithyasystems', '[ROLE — e.g. The finance lead]',
        'The contract register and the actuals export are loaded together. QuickInsight works out how '
        + 'the two sheets relate to each other and joins them automatically — and, importantly, '
        + 'refuses any join that would duplicate rows and quietly inflate the totals. The figures on '
        + 'screen match the figures in the source files, which is the part that manual VLOOKUP work '
        + 'could never guarantee.',
        [
            '[QUESTION 1 — e.g. budget versus actual spend by contract, this quarter]',
            '[QUESTION 2 — e.g. contracts where spend has exceeded budget, largest overrun first]',
            '[QUESTION 3 — e.g. total committed contract value by client]',
            '[QUESTION 4 — e.g. month-by-month spend against a named contract]',
        ],
        'The budget-versus-actual view is saved as a dashboard, so it is now checked [HOW OFTEN] '
        + 'rather than [HOW OFTEN IT USED TO BE]. [WHO] reviews it.'),

    ...dataNote(
        'A contract register holds client names, negotiated rates and contract values — among the '
        + 'most commercially sensitive information a services business has. [ADD ANY CLIENT '
        + 'CONFIDENTIALITY TERM THAT APPLIED.]'),

    ...results('Nithyasystems', [
        { cells: ['Time to produce the budget-versus-actual review', '[N] hours', '[N] minutes'] },
        { cells: ['How often the review is actually run', '[e.g. quarterly]', '[e.g. weekly]'] },
        { cells: ['[OTHER MEASURE]', '[VALUE]', '[VALUE]'] },
    ]),

    ...inTheirWords('Nithyasystems'),
    ...signOff('Nithyasystems'),
];

/* ════════════════════════════════════════════════════════════════════
   3 — Technogence
   ════════════════════════════════════════════════════════════════════ */

const technogence = [
    ...header(
        'Technogence',
        'Software services and training · [CITY], India',
        'Enrolment records sat in a spreadsheet per cohort, counted by hand. The numbers were '
        + 'usually out of date before they reached anyone who needed them.'),
    draftWarning('Technogence'),

    h1('At a glance'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Sector', 'Software services and training'] },
        { boldFirst: true, cells: ['Location', '[CITY], India'] },
        { boldFirst: true, cells: ['Size', '[N] employees'] },
        { boldFirst: true, cells: ['Using QuickInsight since', '[MONTH YEAR]'] },
        { boldFirst: true, cells: ['Used for', 'Training programme enrolment analysis'] },
        { boldFirst: true, cells: ['Data source', 'Excel enrolment records — [DESCRIBE, e.g. one sheet per cohort]'] },
    ]),

    h1('Counting rows by hand'),
    p('Technogence runs [DESCRIBE — e.g. technical training programmes for graduates and corporate '
        + 'clients]. Enrolment is recorded in Excel, [DESCRIBE THE STRUCTURE — e.g. one sheet per '
        + 'intake, maintained by the programme coordinators].'),
    p('It worked well enough for recording. It worked badly for answering questions. Understanding '
        + 'how enrolment was tracking across programmes meant opening each sheet in turn and counting '
        + 'rows — [N] hours per [week / month], for a set of numbers that were usually stale by the '
        + 'time they were circulated.'),
    p('The recurring problems were:'),
    bullet('[DIFFICULTY 1 — e.g. each coordinator structured their sheet slightly differently, so the columns did not line up]'),
    bullet('[DIFFICULTY 2 — e.g. enrolment status was free text, so counting completions meant reading every row]'),
    bullet('[DIFFICULTY 3 — e.g. there was no view of drop-off between enrolment and completion across programmes]'),

    ...whyNotTheUsualAnswers(
        'Technogence', '[ROLE — e.g. the programme coordinators]',
        'Moving the records into a proper system was considered, but replacing a working process for '
        + 'the sake of reporting is a large change to make for a small question, and the coordinators '
        + 'were comfortable in Excel. [CONFIRM OR REPLACE WITH WHAT TECHNOGENCE ACTUALLY CONSIDERED.]'),

    ...whatChanged(
        'Technogence', '[ROLE — e.g. The programme team]',
        'A coordinator loads the enrolment spreadsheet straight into the browser. The inconsistent '
        + 'status values that made counting so laborious are standardised automatically, so '
        + '"Completed", "completed" and "COMPLETE" are counted as one thing rather than three.',
        [
            '[QUESTION 1 — e.g. enrolments by programme, this intake]',
            '[QUESTION 2 — e.g. completion rate by cohort, lowest first]',
            '[QUESTION 3 — e.g. enrolments month by month against the same period last year]',
            '[QUESTION 4 — e.g. drop-off between enrolment and completion by trainer]',
        ],
        'The enrolment summary is now a saved dashboard rather than a task, so the figures are '
        + 'current whenever anyone looks. It is shared with [WHO] [HOW OFTEN].'),

    ...dataNote(
        'Enrolment records hold trainee names, email addresses and telephone numbers — personal data '
        + 'belonging to individuals who signed up for a course, not to Technogence.'),

    ...results('Technogence', [
        { cells: ['Time to produce the enrolment summary', '[N] hours', '[N] minutes'] },
        { cells: ['How current the figures are when circulated', '[e.g. a week old]', '[e.g. same day]'] },
        { cells: ['[OTHER MEASURE]', '[VALUE]', '[VALUE]'] },
    ]),

    ...inTheirWords('Technogence'),
    ...signOff('Technogence'),
];

/* ── build ───────────────────────────────────────────────────────── */

function build(children, out) {
    const doc = new Document({ styles: baseStyles, numbering, sections: [{ properties: PAGE, children }] });
    return Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log('wrote', out); });
}

const DIR = process.argv[2] || '.';
Promise.all([
    build(clicknsend, `${DIR}/QuickInsight-Case-Study-ClickNsend.docx`),
    build(nithya, `${DIR}/QuickInsight-Case-Study-Nithyasystems.docx`),
    build(technogence, `${DIR}/QuickInsight-Case-Study-Technogence.docx`),
]).catch(e => { console.error(e); process.exit(1); });
