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
        'Parcel delivery · InPost vendor · Aberdeen, United Kingdom',
        'The owner of a ten-person parcel business had never used a BI tool and describes his Excel '
        + 'as limited. He now builds his own analysis every week — and uses it to pitch for the work '
        + 'that will grow the company.'),
    draftWarning('ClickNsend'),

    h1('At a glance'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Sector', 'Parcel delivery — vendor for InPost'] },
        { boldFirst: true, cells: ['Location', 'Aberdeen, United Kingdom'] },
        { boldFirst: true, cells: ['Size', '10 employees, one depot'] },
        { boldFirst: true, cells: ['Using QuickInsight since', '2 July 2026'] },
        { boldFirst: true, cells: ['Prior analytics experience', 'None — no BI tool had been used before; self-described limited Excel'] },
        { boldFirst: true, cells: ['Used for', 'Per-employee delivery performance, and building the figures behind new business pitches'] },
        { boldFirst: true, cells: ['Data source', 'Daily manifest exports from the courier platform, as Excel files'] },
    ]),

    h1('A one-depot operation with something to prove'),
    p('ClickNsend delivers parcels in Aberdeen as a vendor for InPost. Ten employees, one depot, and '
        + 'a straightforward business: parcels arrive, parcels go out, and the operation is judged on '
        + 'how reliably that happens.'),
    p('The owner wanted to grow — to take on further depots and win work from other clients. In this '
        + 'industry that growth is not won on price alone. It is won by demonstrating that you '
        + 'already run a tight operation: that your delivery rates hold up, that your returns are '
        + 'low, that your team performs consistently.'),
    p('Performance was, in effect, the product being sold. And it was invisible.'),

    h1('The reports he was given, and the questions he could not ask'),
    p('ClickNsend was not starting from nothing. As a vendor, the owner receives analytics from the '
        + 'courier platform — reports covering the operation, produced to a fixed format.'),
    p('The limitation is not that those reports are poor. It is that they are finished. They answer '
        + 'the questions somebody else decided were worth answering, in the breakdown somebody else '
        + 'chose, and there is no way to ask them anything new. A report can be read. It cannot be '
        + 'interrogated.'),
    p('So when the owner wanted to know something the report did not already show — how one employee '
        + 'compared with another over the last three weeks, or how the return rate moved after a '
        + 'change to the rounds — there was nowhere to put the question.'),

    h1('Downloading the file and hoping'),
    p('The alternative was the raw data. Every day the courier platform produced a manifest export as '
        + 'an Excel file, and the owner downloaded it.'),
    p('What happened next was the problem. He is not an analyst, and describes his own Excel as '
        + 'limited. Producing a view of parcel volumes broken down by employee meant cleaning the '
        + 'file by hand, then building pivot tables from scratch each time somebody asked for a '
        + 'figure — around ten hours a week, in a business where the owner’s time is the scarcest '
        + 'thing there is.'),
    p('Three things made it slower than it should have been:'),
    bullet('Date and status columns came out of the platform in inconsistent formats and had to be cleaned by hand every time.'),
    bullet('Building a weekly picture meant stitching that week’s daily exports together manually, which introduced errors.'),
    bullet('The pivot tables were understood by one person, so the reporting stopped when that person was unavailable.'),
    p('The consequence was that ClickNsend knew its totals but not its breakdown. The owner could say '
        + 'how many parcels went out. He could not reliably say how many each employee delivered, how '
        + 'many came back undelivered, or how those figures moved from one week to the next.'),

    h1('Why the usual answers did not fit'),
    p('Hiring an analyst was never realistic for a business of this size — the cost of the role would '
        + 'have been out of proportion to the problem it solved.'),
    p('A business intelligence tool was not a real option either, and for a more basic reason than '
        + 'price. The owner had never used one. These tools assume somebody who can connect a data '
        + 'source, decide how tables relate to one another and build a model before the first chart '
        + 'appears. That is a skill, it takes time to acquire, and running a depot does not leave '
        + 'that time. Buying the software would not have supplied the person who knows how to use it '
        + '— and that person would have been him.'),

    h1('Learning the four questions'),
    p('What made the difference was not a feature. It was learning a way to think about the data.'),
    p('QuickInsight is built around GAFS — grouping, aggregating, filtering and sorting — the idea '
        + 'that almost every business question is made of the same four parts. What do you want to '
        + 'break the numbers down by? Which figure do you want to measure? Which rows should be '
        + 'included? In what order should the answer come back?'),
    p('"Parcels delivered per employee last week, highest first" is not one question to be looked up. '
        + 'It is four choices: group by employee, count parcels, filter to last week, sort descending. '
        + 'Once that clicks, the number of questions available stops being a fixed list and starts '
        + 'being whatever the owner can think of.'),
    p('The owner learned this framework through the product and now applies it himself in the '
        + 'question builder. He does not write SQL and has not needed to. He uses the plain-English '
        + 'AI feature occasionally, but the majority of his analysis is built by making those four '
        + 'choices directly.'),
    p('This is the change that matters. He did not get a better report. He stopped needing anyone to '
        + 'produce one.'),

    h1('What that looks like in practice'),
    p('The daily manifest export is loaded straight into the browser — the same Excel file that comes '
        + 'out of the courier platform, with no preparation step, nothing installed and nothing '
        + 'configured first.'),
    p('The cleaning that used to be done by hand happens automatically when the file loads. '
        + 'QuickInsight reads the spreadsheet, works out which columns are dates and standardises '
        + 'their formats, identifies which numbers can meaningfully be added up, and tidies '
        + 'inconsistent status values so that the same outcome recorded two different ways is counted '
        + 'once rather than twice.'),
    p('The questions ClickNsend asks are the ones it could never answer before:'),
    bullet('Parcels delivered per employee, by day and by week'),
    bullet('Parcels undelivered per employee, over the same periods'),
    bullet('Percentage of parcels returned'),
    bullet('Percentage of parcels collected'),
    p('The ones asked repeatedly are saved to a dashboard, so they do not need rebuilding. The rest '
        + 'are built as the question arises — which is the point.'),

    h1('Turning performance into a pitch'),
    p('The operational gain was the one ClickNsend went looking for. The commercial one turned out to '
        + 'matter as much.'),
    p('The same charts that show the owner how his depot is performing are the charts he can put in '
        + 'front of a prospective client. Delivery rates per employee, returns as a percentage of '
        + 'volume, week-on-week consistency — presented as visuals rather than described from memory '
        + 'or promised in a spreadsheet he would have to build first.'),
    p('For a vendor trying to win a second depot, that is the difference between asserting that the '
        + 'operation performs and demonstrating it.'),
    p('[ADD THE OUTCOME IF THERE IS ONE YET — meetings held, tenders submitted, work won. If nothing '
        + 'has been won yet, say so plainly or delete this line. Do not imply an outcome that has not '
        + 'happened; the case study is stronger honest and will age better.]'),

    ...dataNote(
        'Parcel manifests contain recipient names, delivery addresses and contact telephone numbers. '
        + 'As a vendor, ClickNsend is handling the personal data of another company’s customers, '
        + 'which raises rather than lowers the stakes.'),

    ...results('ClickNsend', [
        { cells: ['Owner’s time spent on performance reporting', 'About 10 hours per week', '[N] [minutes / hours] per week'] },
        { cells: ['Questions that can be asked of the data', 'Whatever the vendor report already showed', 'Any question the owner can frame'] },
        { cells: ['Per-employee delivery figures', 'Not available', '[e.g. daily and weekly]'] },
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
        'Software development, process outsourcing and IT consulting · Texas, USA',
        'An IT services company with Power BI in place and one analyst to run it. The bottleneck was '
        + 'never the tooling — it was that every question, however small, had to go through the same '
        + 'person.'),
    draftWarning('Nithyasystems'),

    h1('At a glance'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Sector', 'Software development, process outsourcing and IT consulting'] },
        { boldFirst: true, cells: ['Location', 'Texas, USA'] },
        { boldFirst: true, cells: ['Size', '22 employees'] },
        { boldFirst: true, cells: ['Using QuickInsight since', '2 July 2026'] },
        { boldFirst: true, cells: ['Used alongside', 'Power BI — retained for complex and governed reporting'] },
        { boldFirst: true, cells: ['Used for', 'Quick ad-hoc sales analysis: daily and weekly sales, and week-, month- and year-to-date figures by product'] },
    ]),

    h1('A data company with a data bottleneck'),
    p('Nithyasystems provides software development, process outsourcing and IT consulting to '
        + 'businesses and government agencies across sectors including banking and finance, '
        + 'healthcare, education, retail and hospitality. Data work is what the company does for a '
        + 'living.'),
    p('Internally, its own reporting runs on Power BI, maintained by a single data analyst.'),
    p('That is a perfectly reasonable setup, and for the work Power BI is designed for it works well. '
        + 'The difficulty was never the platform. It was that one analyst had become the route through '
        + 'which every question had to travel.'),

    h1('What Power BI is for, and what it is not'),
    p('Power BI is the right tool for governed, recurring, complex reporting — the reports that '
        + 'matter, that need to be consistent, and that people depend on. Nithyasystems continues to '
        + 'use it for exactly that, and has no intention of changing.'),
    p('The mismatch appears at the other end of the scale. Somebody wants to know what was sold '
        + 'today. Or this week. Or how a particular product is tracking month-to-date against '
        + 'year-to-date. These are small questions with short answers.'),
    p('Where an existing report already covers the question, it is answered in seconds. Where it does '
        + 'not — which is most of the time for a question nobody anticipated — answering it requires '
        + 'changes to the dataset, the model or the report logic, and someone who knows Power BI well '
        + 'enough to make them safely. For a question whose answer is a single number, the cost of '
        + 'asking exceeded the value of knowing.'),
    p('So the small questions either went into the analyst’s queue, or went unasked.'),

    h1('One analyst, everyone’s questions'),
    p('The queue is the part that does the damage, and it is easy to miss because nothing about it '
        + 'looks broken.'),
    p('Trivial questions and genuinely important ones enter the same queue and are served in roughly '
        + 'the order they arrive. The analyst spends a meaningful part of the week producing figures '
        + 'that required no analytical judgement at all, while the work that genuinely needs their '
        + 'expertise waits behind it. Meanwhile the person who asked for today’s sales figure gets it '
        + 'once the analyst reaches them — by which point they have either moved on or made the '
        + 'decision without it.'),
    p('Hiring a second analyst would have helped, but it treats a routing problem as a capacity '
        + 'problem — the new analyst joins the same queue.'),
    p('Giving everyone a Power BI licence would not have helped either. The licence is not the '
        + 'barrier; the modelling knowledge is. Handing the tool to someone who does not have that '
        + 'knowledge produces either nothing or, worse, a confidently wrong number.'),

    h1('What changed — a hybrid, not a replacement'),
    p('Nithyasystems began using QuickInsight in July 2026 alongside Power BI rather than instead of '
        + 'it. The two are used for different halves of the problem:'),
    table([4513, 4513], [
        { head: true, cells: ['Power BI', 'QuickInsight'] },
        {
            cells: [
                'Governed, recurring reporting. Complex models. Anything the business depends on and needs to be consistent. Built and maintained by the analyst.',
                'Quick ad-hoc questions. Exploration. Same-day answers. Used directly by the people who have the question.',
            ],
        },
    ]),
    spacer(220),
    p('The division is deliberate, and Nithyasystems is clear about where the line sits. QuickInsight '
        + 'is not used for statutory reporting, board reporting or executive dashboards. Those remain '
        + 'in Power BI, built and governed by the analyst, and there is no plan to move them.'),
    p('A spreadsheet export is loaded straight into the browser and cleaned automatically — date '
        + 'columns detected and standardised, additive and non-additive numbers distinguished, '
        + 'inconsistent category values tidied so the same product spelled two ways is counted once. '
        + 'There is no extract-transform-load step to build, no model to define, and nothing to '
        + 'install.'),
    p('Questions are then asked either through the guided question builder — choosing what to break '
        + 'the numbers down by, which figure to measure, which rows to include and how to order the '
        + 'result — or simply typed in plain English. The underlying query stays visible, which '
        + 'matters in a company where people know enough to want to check it.'),
    p('The questions it handles are the ones that were clogging the queue:'),
    bullet('Today’s sales, and this week’s'),
    bullet('Week-to-date, month-to-date and year-to-date sales by product'),
    bullet('Product-wise sales distribution breakdown'),
    bullet('This month against the same month last year, by product'),

    h1('What the analyst got back'),
    p('The point of the change was not to produce figures faster, although it does. It was to take '
        + 'the questions that never needed an analyst out of the analyst’s queue.'),
    p('About ten hours of the analyst’s week were previously spent on ad-hoc requests. That time is '
        + 'now spent instead on developing more complex dashboards and maintaining the company’s data '
        + 'infrastructure — work that requires modelling judgement, governance and genuine analytical '
        + 'skill, and which now reaches the analyst without waiting behind a request for a daily '
        + 'sales total.'),

    h1('Decisions made in the room'),
    p('The change showed up somewhere nobody had planned for: in meetings.'),
    p('During routine sales reviews, product-level performance can now be examined immediately, while '
        + 'the discussion is still happening, rather than being sent away as follow-up analysis to '
        + 'return later in the week. Meetings end with a decision made on current figures instead of '
        + 'an action deferred pending a report.'),
    p('[ONE REAL EXAMPLE FROM NITHYASYSTEMS — a specific occasion when this happened. Roughly: '
        + '"During a sales review, a manager asked why a particular product had fallen behind the '
        + 'previous week. Rather than requesting a new report, the exported spreadsheet was opened in '
        + 'QuickInsight and the breakdown was on screen within minutes, and the discussion continued." '
        + 'Ask them for the actual occasion — do not use this wording as written, and delete this '
        + 'paragraph entirely if they cannot recall a specific one.]'),

    h1('A note on the data itself'),
    p('Sales data by product and client is commercially sensitive, and as an IT services business '
        + 'Nithyasystems applies the same standards to its own information that it applies on behalf '
        + 'of its clients. Certain commercially sensitive figures have been withheld or anonymised in '
        + 'this document in accordance with internal confidentiality policies and contractual '
        + 'obligations to clients.'),
    p('QuickInsight does its work inside the web browser on the user’s own computer. The spreadsheet '
        + 'is never uploaded to a server at all. Where the plain-English question feature is used, '
        + 'only the structure of the data is sent — table names, column names and data types. No data '
        + 'values are sent unless the user explicitly switches that on, and even then anything '
        + 'resembling a name, an identifier, contact details or a sensitive category is excluded '
        + 'automatically, with the user able to switch off any remaining column or individual value '
        + 'first.'),
    p('Because the analysis happens locally and the data never leaves the machine, adopting the tool '
        + 'required no supplier security assessment and no decision about where company data would be '
        + 'stored.'),

    h1('Results'),
    table([4200, 2400, 2426], [
        { head: true, cells: ['Measure', 'Before', 'After'] },
        { cells: ['Wait for an ad-hoc sales figure', 'Days, depending on analyst availability', 'Minutes'] },
        { cells: ['Analyst time spent on ad-hoc requests', 'About 10 hours per week', 'Near zero for routine requests'] },
        { cells: ['People able to answer a basic sales question', '1', 'Business users, directly'] },
    ]),

    h1('In their words'),
    pullQuote('"QuickInsight hasn’t replaced Power BI for us — it has reduced the number of everyday '
        + 'questions reaching our analyst. Staff can answer routine sales questions themselves, while '
        + 'the analyst spends more time improving our reporting."'),
    p('— [NAME], [JOB TITLE], Nithyasystems', { indent: { left: 480 } }),

    ...signOff('Nithyasystems'),
];

/* ════════════════════════════════════════════════════════════════════
   3 — Technogence
   ════════════════════════════════════════════════════════════════════ */

const technogence = [
    ...header(
        'Technogence',
        'Software services and training · [CITY], India',
        'Every question meant cleaning a spreadsheet and writing formulas first. Managers were '
        + 'spending hours proving things that turned out not to be true — and, more often, not '
        + 'asking at all.'),
    draftWarning('Technogence'),

    h1('At a glance'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Sector', 'Software services and training'] },
        { boldFirst: true, cells: ['Location', '[CITY], India'] },
        { boldFirst: true, cells: ['Size', '[N] employees'] },
        { boldFirst: true, cells: ['Using QuickInsight since', '[MONTH YEAR]'] },
        { boldFirst: true, cells: ['Used for', 'Student enrolment analysis, management dashboards, and checking ideas before they are presented'] },
        { boldFirst: true, cells: ['Data source', 'Excel enrolment records for the courses Technogence provides — [DESCRIBE THE STRUCTURE, e.g. one sheet per intake]'] },
    ]),

    h1('An Excel business'),
    p('Technogence runs [DESCRIBE — e.g. technical courses alongside its software services work]. '
        + 'Like a great many companies, it runs its analysis in Excel. Not as a stopgap, and not '
        + 'because nobody knows better — Excel is genuinely the right tool for most of what the team '
        + 'does. Small tasks, quick checks, one-off pieces of work.'),
    p('The difficulty is not Excel itself. It is what has to happen before Excel can answer anything.'),

    h1('The cost of a question'),
    p('Enrolment data arrives as spreadsheets that were built for recording, not for analysis. Before '
        + 'any question could be answered, someone had to clean the file by hand — standardising '
        + 'inconsistent entries, fixing date columns, making the same thing spelled three ways count '
        + 'as one thing — and then write the formulas to produce the answer.'),
    p('For a single reported figure that is a manageable overhead. Repeated across every question '
        + 'anyone thinks to ask, it becomes the job.'),
    p('The recurring problems were:'),
    bullet('[DIFFICULTY 1 — e.g. each coordinator structured their sheet slightly differently, so the columns did not line up]'),
    bullet('[DIFFICULTY 2 — e.g. enrolment status was recorded as free text, so counting completions meant reading every row]'),
    bullet('[DIFFICULTY 3 — e.g. the formulas that produced last quarter’s numbers were not reusable on this quarter’s file]'),

    h1('The questions that never got asked'),
    p('The obvious cost of all this is time. The less obvious cost, and the more damaging one, is the '
        + 'analysis that never happens.'),
    p('When checking an idea takes an hour of cleaning and formula-writing, people stop checking '
        + 'ideas. A manager with a hunch about which courses were losing students between enrolment '
        + 'and completion faced a choice: spend the afternoon finding out, or go into the meeting and '
        + 'say it anyway. Neither is good. The first is expensive; the second means decisions get '
        + 'made on impressions.'),
    p('Curiosity had a price, so there was less of it than there should have been.'),

    ...whyNotTheUsualAnswers(
        'Technogence', 'the managers doing the analysis',
        'Moving the enrolment records into a proper system was considered, but replacing a working '
        + 'process for the sake of reporting is a large change to make for a small question, and the '
        + 'team was comfortable in Excel. '
        + '[CONFIRM OR REPLACE WITH WHAT TECHNOGENCE ACTUALLY CONSIDERED.]'),

    h1('What changed'),
    p('Technogence started using QuickInsight in [MONTH YEAR], not to replace Excel but to replace '
        + 'the manual work that had to happen before Excel could be useful.'),
    p('The enrolment spreadsheet is loaded straight into the browser, exactly as it is. The cleaning '
        + 'that used to be done by hand happens automatically: date columns are detected and '
        + 'standardised, numbers that can meaningfully be added up are distinguished from those that '
        + 'cannot, and inconsistent category values are tidied so that "Completed", "completed" and '
        + '"COMPLETE" are counted once rather than three times.'),
    p('Questions are then asked in one of two ways. The guided question builder works by choosing '
        + 'what to break the numbers down by, which figure to measure, which rows to include and how '
        + 'to order the result — the four things every business question is made of. Alternatively '
        + 'the question can simply be typed in plain English. Either way a chart or table appears, '
        + 'with the underlying query visible for anyone who wants to check it.'),
    p('Typical questions include:'),
    bullet('[QUESTION 1 — e.g. enrolments by course, this intake]'),
    bullet('[QUESTION 2 — e.g. completion rate by course, lowest first]'),
    bullet('[QUESTION 3 — e.g. enrolments month by month against the same period last year]'),
    bullet('[QUESTION 4 — e.g. drop-off between enrolment and completion, by course]'),
    p('No formulas are written. No file is cleaned by hand first.'),

    h1('Checking an idea before taking it upstairs'),
    p('The use that emerged on its own was not the one anyone planned for.'),
    p('Managers began using QuickInsight privately, to check whether an idea held up in the data '
        + 'before presenting it. Someone suspects a particular course is losing students earlier than '
        + 'the others; rather than building the analysis to find out, they ask the question, look at '
        + 'the answer, and know within a minute or two whether there is anything there.'),
    p('The effect is that ideas arrive at management meetings already tested. Three hunches get '
        + 'checked and the two that were wrong are dropped quietly, instead of one being presented '
        + 'unverified and argued about in the room. Being wrong in private is cheap; being wrong in '
        + 'front of the leadership team is not.'),
    p('This only works because the cost of asking has collapsed. At an hour a question, nobody '
        + 'explores. At a minute a question, they do. '
        + '[ADD A SPECIFIC EXAMPLE IF A MANAGER IS WILLING TO GIVE ONE — an idea that was checked and '
        + 'turned out to be wrong is more convincing here than one that was right.]'),

    h1('Dashboards for management'),
    p('The analyses that get asked for repeatedly are saved as dashboards and presented to senior '
        + 'management, rather than being rebuilt into slides each time. The figures are current '
        + 'whenever anyone opens them, so the enrolment picture shown in a management meeting is the '
        + 'position today rather than the position on the day someone last had time to compile it.'),
    p('[CONFIRM HOW OFTEN THESE ARE REVIEWED AND BY WHOM.]'),

    ...dataNote(
        'Enrolment records hold student names, email addresses and telephone numbers — personal data '
        + 'belonging to the individuals who signed up for a course, not to Technogence.'),

    ...results('Technogence', [
        { cells: ['Time to prepare a file before it can be analysed', '[N] [hours]', 'None — cleaning is automatic'] },
        { cells: ['Time to produce the enrolment summary', '[N] hours', '[N] minutes'] },
        { cells: ['How current the figures are when presented', '[e.g. a week old]', '[e.g. same day]'] },
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
