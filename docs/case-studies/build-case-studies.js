const fs = require('fs');
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
    LevelFormat, PageBreak,
} = require('docx');

/* ── helpers (shared with build-docx.js) ─────────────────────────── */

function runs(text, opts = {}) {
    return text.split(/(\[[^\]]+\])/g).filter(Boolean).map(p =>
        p.startsWith('[')
            ? new TextRun({ text: p, highlight: 'yellow', bold: true, ...opts })
            : new TextRun({ text: p, ...opts }));
}

const p = (text, opts = {}) => new Paragraph({
    children: runs(text, opts.run || {}),
    spacing: { after: opts.after ?? 160, line: 276 },
    alignment: opts.align,
    indent: opts.indent,
    ...(opts.border ? { border: opts.border } : {}),
});

const h1 = text => new Paragraph({
    text, heading: HeadingLevel.HEADING_1, spacing: { before: 340, after: 160 },
});
const h2 = text => new Paragraph({
    text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 },
});
const spacer = (after = 140) => new Paragraph({ text: '', spacing: { after } });

const RULE = { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 6 } };

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
        document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 276 } } },
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

function header(company, strapline) {
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
            spacing: { after: 60 },
        }),
        new Paragraph({ text: '', border: RULE, spacing: { after: 300 } }),
    ];
}

/** The product description — factual, identical across all three. */
function howItWorks(dataDescription) {
    return [
        h1('Why the data could not go to a cloud BI tool'),
        p(dataDescription),
        p('QuickInsight takes a different approach. It loads the spreadsheet into an analytical '
            + 'database that runs inside the web browser on the user’s own computer. Cleaning, '
            + 'profiling, query execution and charting all happen on that machine. The file is never '
            + 'uploaded to a server.'),
        p('Where the AI features are used to interpret a typed question, only the structure of the '
            + 'data is sent — table names, column names and data types. No data values are sent '
            + 'unless the user explicitly turns that on, and even then the tool automatically '
            + 'excludes anything that looks like a name, an identifier, contact details or a '
            + 'sensitive category, and lets the user switch off any remaining column or individual '
            + 'value before it goes.'),
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
        bullet('If the customer cannot give a number, delete that row rather than estimating. An empty results table with three real rows beats six rows where three are guesses.'),
        bullet('Send as PDF once the placeholders are filled. Ask for a signed scan back.'),
        bullet('The quote must be the customer’s own words. If they ask you to draft one, send it as a suggestion and let them rewrite it.'),
        bullet('Keep the signed original. It is a stronger evidence document than anything you write about yourself.'),
    ];
}

/* ════════════════════════════════════════════════════════════════════
   1 — ClickNsend
   ════════════════════════════════════════════════════════════════════ */

const clicknsend = [
    ...header('ClickNsend', 'Logistics and parcel delivery · United Kingdom'),
    draftWarning('ClickNsend'),

    h1('At a glance'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Sector', 'Logistics and parcel delivery'] },
        { boldFirst: true, cells: ['Location', '[CITY], United Kingdom'] },
        { boldFirst: true, cells: ['Size', '[N] employees'] },
        { boldFirst: true, cells: ['Using QuickInsight since', '[MONTH YEAR]'] },
        { boldFirst: true, cells: ['Used for', 'Parcel volume tracking and delivery performance analysis'] },
        { boldFirst: true, cells: ['Data source', '[DESCRIBE — e.g. daily manifest exports from the courier platform, as Excel files]'] },
    ]),

    h1('The situation before'),
    p('ClickNsend’s operational data arrived as [DESCRIBE THE EXPORT — e.g. a spreadsheet per depot '
        + 'per week, exported from the courier management system]. Reporting was produced by '
        + '[WHO — e.g. the operations manager] using Excel pivot tables, rebuilt [HOW OFTEN].'),
    p('Producing a single view of parcel volumes across [DIMENSION — e.g. depots and service tiers] '
        + 'took approximately [N] hours per [WEEK / MONTH].'),
    p('The specific difficulties were:'),
    bullet('[DIFFICULTY 1 — e.g. date and status columns arrived in inconsistent formats and had to be cleaned by hand each time]'),
    bullet('[DIFFICULTY 2 — e.g. combining depots meant copying sheets together manually, which introduced errors]'),
    bullet('[DIFFICULTY 3 — e.g. only one person understood how the pivot tables were constructed, so reporting stopped when they were away]'),

    ...howItWorks(
        'Parcel manifests contain recipient names, delivery addresses and contact telephone numbers. '
        + 'Uploading that data to a third-party analytics service would have meant [DESCRIBE '
        + 'CLICKNSEND’S POSITION — e.g. carrying out a data protection impact assessment, or would '
        + 'have been prohibited by internal policy]. [ADD ANY CUSTOMER OR CLIENT CONTRACTUAL '
        + 'RESTRICTION THAT APPLIED.]'),

    h1('What ClickNsend does with QuickInsight'),
    p('The operations team loads the [WEEKLY / DAILY] manifest export directly into the browser. '
        + 'QuickInsight profiles the file automatically — detecting date columns, identifying which '
        + 'numeric columns can be summed, and flagging columns that contain personal data.'),
    p('Questions are then asked either through the guided question builder or by typing them in '
        + 'plain English. Typical questions include:'),
    bullet('[QUESTION 1 — e.g. parcel volume by depot, by week]'),
    bullet('[QUESTION 2 — e.g. failed delivery rate by postcode area]'),
    bullet('[QUESTION 3 — e.g. average parcels per driver per day, ranked]'),
    bullet('[QUESTION 4 — e.g. week-on-week change in volume by service tier]'),
    p('The results are saved to a dashboard that [WHO] reviews [HOW OFTEN].'),

    h1('Results'),
    p('[ClickNsend to complete. Use only figures ClickNsend can stand behind. Delete any row that '
        + 'cannot be evidenced.]'),
    table([4200, 2400, 2426], [
        { head: true, cells: ['Measure', 'Before', 'After'] },
        { cells: ['Time to produce the [WEEKLY] volume report', '[N] hours', '[N] minutes'] },
        { cells: ['People able to produce it', '[N]', '[N]'] },
        { cells: ['[OTHER MEASURE]', '[VALUE]', '[VALUE]'] },
    ]),
    spacer(200),
    p('[ADD ANY OUTCOME THAT IS NOT A TIME SAVING — e.g. a decision that was made differently '
        + 'because of something the analysis revealed. These are often more persuasive than the '
        + 'hours saved.]'),

    h1('In their words'),
    new Paragraph({
        children: [new TextRun({
            text: '"[QUOTE — in the customer’s own words. What changed for them, and what they would '
                + 'say to someone considering it.]"',
            italics: true, size: 24,
        })],
        spacing: { after: 140 }, indent: { left: 480 },
    }),
    p('— [NAME], [JOB TITLE], ClickNsend', { indent: { left: 480 } }),

    ...signOff('ClickNsend'),
];

/* ════════════════════════════════════════════════════════════════════
   2 — Nithyasystems
   ════════════════════════════════════════════════════════════════════ */

const nithya = [
    ...header('Nithyasystems', 'Software services · [COUNTRY]'),
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

    h1('The situation before'),
    p('Nithyasystems tracked its client contracts and the budget attached to each one across '
        + '[DESCRIBE — e.g. several spreadsheets maintained by different people: a contract register, '
        + 'a budget sheet, and a monthly actuals export].'),
    p('Answering a question as simple as "which contracts are over budget this quarter" required '
        + '[DESCRIBE THE MANUAL PROCESS — e.g. matching contract references between two sheets by '
        + 'hand with VLOOKUP], which took roughly [N] hours and had to be redone whenever the '
        + 'actuals were updated.'),
    p('The specific difficulties were:'),
    bullet('[DIFFICULTY 1 — e.g. contract references were formatted differently in each sheet, so lookups silently failed]'),
    bullet('[DIFFICULTY 2 — e.g. budget figures and actuals lived in separate files that were never reconciled between quarter ends]'),
    bullet('[DIFFICULTY 3 — e.g. there was no reliable view of total committed spend across all live contracts]'),

    ...howItWorks(
        'Contract registers contain client names, negotiated rates and contract values. This is '
        + 'commercially sensitive information, and [DESCRIBE NITHYASYSTEMS’ POSITION — e.g. several '
        + 'client contracts include confidentiality terms that prevent the data being shared with '
        + 'third-party services].'),

    h1('What Nithyasystems does with QuickInsight'),
    p('The [ROLE — e.g. finance lead] loads the contract register and the actuals export together. '
        + 'QuickInsight detects the relationship between the two sheets automatically and joins them, '
        + 'refusing any join that would duplicate rows and inflate the totals — so the figures on '
        + 'screen match the figures in the source files.'),
    p('Typical questions include:'),
    bullet('[QUESTION 1 — e.g. budget versus actual spend by contract, for the current quarter]'),
    bullet('[QUESTION 2 — e.g. contracts where actual spend has exceeded budget, largest overrun first]'),
    bullet('[QUESTION 3 — e.g. total committed contract value by client]'),
    bullet('[QUESTION 4 — e.g. month-by-month spend against a named contract]'),
    p('The results are saved to a dashboard reviewed [HOW OFTEN] by [WHO].'),

    h1('Results'),
    p('[Nithyasystems to complete. Use only figures Nithyasystems can stand behind. Delete any row '
        + 'that cannot be evidenced.]'),
    table([4200, 2400, 2426], [
        { head: true, cells: ['Measure', 'Before', 'After'] },
        { cells: ['Time to produce the budget-versus-actual review', '[N] hours', '[N] minutes'] },
        { cells: ['Frequency the review is actually run', '[e.g. quarterly]', '[e.g. weekly]'] },
        { cells: ['[OTHER MEASURE]', '[VALUE]', '[VALUE]'] },
    ]),
    spacer(200),
    p('[ADD ANY OUTCOME THAT IS NOT A TIME SAVING — e.g. an overrun identified early enough to act '
        + 'on, or a reconciliation error found. Specific incidents are more persuasive than '
        + 'averages.]'),

    h1('In their words'),
    new Paragraph({
        children: [new TextRun({
            text: '"[QUOTE — in the customer’s own words.]"',
            italics: true, size: 24,
        })],
        spacing: { after: 140 }, indent: { left: 480 },
    }),
    p('— [NAME], [JOB TITLE], Nithyasystems', { indent: { left: 480 } }),

    ...signOff('Nithyasystems'),
];

/* ════════════════════════════════════════════════════════════════════
   3 — Technogence
   ════════════════════════════════════════════════════════════════════ */

const technogence = [
    ...header('Technogence', 'Software services · India'),
    draftWarning('Technogence'),

    h1('At a glance'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Sector', 'Software services'] },
        { boldFirst: true, cells: ['Location', '[CITY], India'] },
        { boldFirst: true, cells: ['Size', '[N] employees'] },
        { boldFirst: true, cells: ['Using QuickInsight since', '[MONTH YEAR]'] },
        { boldFirst: true, cells: ['Used for', 'Training programme enrolment analysis'] },
        { boldFirst: true, cells: ['Data source', 'Excel enrolment records — [DESCRIBE, e.g. one sheet per cohort]'] },
    ]),

    h1('The situation before'),
    p('Technogence runs [DESCRIBE — e.g. technical training programmes for graduates and corporate '
        + 'clients]. Enrolment records were kept in Excel, [DESCRIBE THE STRUCTURE — e.g. one sheet '
        + 'per programme intake, maintained by the programme coordinators].'),
    p('Understanding how enrolment was tracking across programmes meant [DESCRIBE THE MANUAL '
        + 'PROCESS — e.g. opening each sheet in turn and counting rows by hand], which took '
        + '[N] hours per [WEEK / MONTH] and was usually out of date by the time it was circulated.'),
    p('The specific difficulties were:'),
    bullet('[DIFFICULTY 1 — e.g. each coordinator structured their sheet slightly differently, so the columns did not line up]'),
    bullet('[DIFFICULTY 2 — e.g. enrolment status was recorded as free text, so counting completions meant reading every row]'),
    bullet('[DIFFICULTY 3 — e.g. there was no view of drop-off between enrolment and completion across programmes]'),

    ...howItWorks(
        'Enrolment records contain trainee names, email addresses and telephone numbers. Uploading '
        + 'them to a third-party analytics service would have meant sharing the personal data of '
        + 'individuals who had enrolled on a training programme, which [DESCRIBE TECHNOGENCE’S '
        + 'POSITION — e.g. was not something Technogence was prepared to do, and would have required '
        + 'consent it had not obtained].'),

    h1('What Technogence does with QuickInsight'),
    p('A coordinator loads the enrolment spreadsheet into the browser. QuickInsight cleans it '
        + 'automatically — standardising the status values, detecting the date columns, and '
        + 'identifying the name, email and telephone columns as personal data so they are excluded '
        + 'from anything sent to the AI features.'),
    p('Typical questions include:'),
    bullet('[QUESTION 1 — e.g. enrolments by programme, this intake]'),
    bullet('[QUESTION 2 — e.g. completion rate by cohort, lowest first]'),
    bullet('[QUESTION 3 — e.g. enrolment numbers month by month, compared with the same period last year]'),
    bullet('[QUESTION 4 — e.g. drop-off between enrolment and completion by trainer]'),
    p('The results are saved to a dashboard shared with [WHO] [HOW OFTEN].'),

    h1('Results'),
    p('[Technogence to complete. Use only figures Technogence can stand behind. Delete any row that '
        + 'cannot be evidenced.]'),
    table([4200, 2400, 2426], [
        { head: true, cells: ['Measure', 'Before', 'After'] },
        { cells: ['Time to produce the enrolment summary', '[N] hours', '[N] minutes'] },
        { cells: ['How current the figures are when circulated', '[e.g. a week old]', '[e.g. same day]'] },
        { cells: ['[OTHER MEASURE]', '[VALUE]', '[VALUE]'] },
    ]),
    spacer(200),
    p('[ADD ANY OUTCOME THAT IS NOT A TIME SAVING — e.g. a programme with unexpectedly high drop-off '
        + 'that was identified and changed as a result.]'),

    h1('In their words'),
    new Paragraph({
        children: [new TextRun({
            text: '"[QUOTE — in the customer’s own words.]"',
            italics: true, size: 24,
        })],
        spacing: { after: 140 }, indent: { left: 480 },
    }),
    p('— [NAME], [JOB TITLE], Technogence', { indent: { left: 480 } }),

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
