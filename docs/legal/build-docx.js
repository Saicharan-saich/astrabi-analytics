const fs = require('fs');
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
    LevelFormat, PageBreak, convertInchesToTwip,
} = require('docx');

const CONTENT_W = 9026; // A4 minus 1" margins each side

/* ── helpers ─────────────────────────────────────────────────────── */

// Renders [PLACEHOLDERS] highlighted so they are easy to find and replace.
function runs(text, opts = {}) {
    return text.split(/(\[[^\]]+\])/g).filter(Boolean).map(p =>
        p.startsWith('[')
            ? new TextRun({ text: p, highlight: 'yellow', bold: true, ...opts })
            : new TextRun({ text: p, ...opts }));
}

const p = (text, opts = {}) => new Paragraph({
    children: runs(text, opts.run || {}),
    spacing: { after: opts.after ?? 140, line: 276 },
    alignment: opts.align,
    indent: opts.indent,
    ...(opts.border ? { border: opts.border } : {}),
});

const h1 = text => new Paragraph({
    text, heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 160 },
});
const h2 = text => new Paragraph({
    text, heading: HeadingLevel.HEADING_2, spacing: { before: 260, after: 120 },
});
const title = text => new Paragraph({
    children: [new TextRun({ text, bold: true, size: 32 })],
    alignment: AlignmentType.CENTER, spacing: { after: 240 },
});
const spacer = (after = 120) => new Paragraph({ text: '', spacing: { after } });

/** A clause: bold number then body, with placeholders highlighted. */
function clause(num, text, opts = {}) {
    return new Paragraph({
        children: [new TextRun({ text: num + '\t', bold: true }), ...runs(text, opts.run || {})],
        spacing: { after: 140, line: 276 },
        indent: opts.indent || { left: 720, hanging: 720 },
    });
}

/** Sub-paragraph like "(a) ..." */
const sub = text => new Paragraph({
    children: runs(text),
    spacing: { after: 120, line: 276 },
    indent: { left: 1440, hanging: 480 },
});

/** Definition line: bold term, then body. */
function defn(term, body) {
    return new Paragraph({
        children: [new TextRun({ text: term, bold: true }), ...runs(' ' + body)],
        spacing: { after: 140, line: 276 },
        indent: { left: 720 },
    });
}

function cell(text, o = {}) {
    return new TableCell({
        width: { size: o.w, type: WidthType.DXA },
        shading: o.shade ? { type: ShadingType.CLEAR, color: 'auto', fill: o.shade } : undefined,
        margins: { top: 100, bottom: 100, left: 140, right: 140 },
        verticalAlign: 'center',
        children: (Array.isArray(text) ? text : [text]).map(t => new Paragraph({
            children: runs(t, { bold: o.bold, size: 20 }),
            alignment: o.align,
            spacing: { after: 0, line: 260 },
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
                shade: r.head ? 'E8EAF0' : r.shade,
                align: r.align && r.align[i],
            })),
            tableHeader: !!r.head,
        })),
    });
}

const RULE = {
    bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 6 },
};

const numbering = {
    config: [{
        reference: 'bullets',
        levels: [{
            level: 0, format: LevelFormat.BULLET, text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
    }],
};

const bullet = text => new Paragraph({
    children: runs(text),
    numbering: { reference: 'bullets', level: 0 },
    spacing: { after: 100, line: 276 },
});

const baseStyles = {
    default: {
        document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 276 } } },
        heading1: { run: { font: 'Calibri', size: 26, bold: true, color: '1A1A2E' } },
        heading2: { run: { font: 'Calibri', size: 23, bold: true, color: '333344' } },
    },
};

const PAGE = {
    page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
};

/* ════════════════════════════════════════════════════════════════════
   DOCUMENT 1 — USER AGREEMENT
   ════════════════════════════════════════════════════════════════════ */

const agreement = [
    title('AGREEMENT FOR THE SUPPLY OF SOFTWARE AS A SERVICE'),

    new Paragraph({
        children: [new TextRun({
            text: 'DRAFT — have this reviewed by a solicitor before sending. '
                + 'Every highlighted placeholder must be replaced. Delete this box and the '
                + '"Notes for the Supplier" section at the end before sending.',
            italics: true, size: 20, color: '8A1C1C',
        })],
        spacing: { after: 300 }, border: RULE,
    }),

    p('This Agreement is dated [DATE]'),
    spacer(),

    h1('BETWEEN'),
    p('(1) [YOUR FULL LEGAL NAME], a sole trader trading as QuickInsight, of [YOUR ADDRESS], '
        + 'United Kingdom ("the Supplier"); and'),
    p('(2) [CUSTOMER COMPANY NAME], a company registered in [COUNTRY] under company number '
        + '[NUMBER], whose registered office is at [ADDRESS] ("the Customer").'),
    new Paragraph({
        children: [new TextRun({
            text: 'Once QuickInsight is incorporated, replace party (1) with: "QuickInsight Ltd, '
                + 'a company registered in England and Wales under company number [NUMBER], whose '
                + 'registered office is at [ADDRESS]".',
            italics: true, size: 19, color: '555566',
        })],
        spacing: { after: 200 }, indent: { left: 360 },
    }),

    h1('1.  DEFINITIONS'),
    clause('1.1', 'In this Agreement:'),
    defn('"Agreement"', 'means these terms together with all Schedules.'),
    defn('"Authorised User"', 'means an employee, contractor or agent of the Customer whom the Customer permits to use the Service.'),
    defn('"Account Data"', 'means data the Supplier holds about the Customer and its Authorised Users, as listed in Schedule 2.'),
    defn('"Customer Data"', 'means the files, spreadsheets, databases and other data the Customer loads into the Service for analysis.'),
    defn('"Derived Output"', 'means charts, dashboards, aggregated figures, SQL queries and narrative insights produced by the Service from Customer Data.'),
    defn('"Effective Date"', 'means the date at the head of this Agreement.'),
    defn('"Service"', 'means the QuickInsight software-as-a-service application made available at quickinsight.co.uk, described in Schedule 1.'),
    defn('"AI Features"', 'means those parts of the Service that send information to a third-party large language model provider, as described in Schedule 1 paragraph 4.'),

    h1('2.  THE SERVICE'),
    clause('2.1', 'The Supplier grants the Customer a non-exclusive, non-transferable right for its Authorised Users to access and use the Service for the Customer’s internal business purposes for the Term.'),
    clause('2.2', 'The Service is delivered over the internet. The Customer is responsible for its own internet access, browsers and devices.'),
    clause('2.3', 'How the Service processes data. The Service performs its analysis inside the Authorised User’s web browser using an in-browser analytical database. Customer Data files are not uploaded to, transmitted to, or stored by the Supplier, save for the specific and limited exceptions set out in Schedule 1 paragraphs 3 and 4. The Customer acknowledges that this architecture is a material feature of the Service.'),
    clause('2.4', 'The Supplier may update the Service from time to time. The Supplier will not make an update that materially reduces the Service’s functionality or weakens the data-handling position described in Schedule 1 without giving the Customer [30] days’ written notice.'),

    h1('3.  FEES'),
    h2('Option A — paid subscription (delete whichever does not apply)'),
    clause('3.1', 'The Customer shall pay the Supplier [£AMOUNT] per [month / year] for up to [N] Authorised Users.'),
    clause('3.2', 'The Supplier shall invoice [monthly / annually] in advance. Invoices are payable within [30] days of the invoice date.'),
    clause('3.3', 'All fees are exclusive of VAT. The Supplier is not currently VAT-registered and will not charge VAT accordingly.'),
    clause('3.4', 'Fees may be increased once in any twelve-month period on [60] days’ written notice.'),
    h2('Option B — no-charge evaluation (delete whichever does not apply)'),
    clause('3.1', 'The Service is provided free of charge for an evaluation period of [90] days from the Effective Date ("Evaluation Period").'),
    clause('3.2', 'During the Evaluation Period the Customer shall provide the Supplier with reasonable feedback on the Service, including at least one written summary of its experience at the end of the period.'),
    clause('3.3', 'After the Evaluation Period the parties may agree paid terms in writing. If they do not, either party may terminate under clause 11.'),

    h1('4.  CUSTOMER OBLIGATIONS'),
    clause('4.1', 'The Customer shall:'),
    sub('(a) ensure Authorised Users comply with this Agreement;'),
    sub('(b) keep account credentials confidential and notify the Supplier promptly of any suspected unauthorised access;'),
    sub('(c) ensure it has the lawful right to process all Customer Data it loads into the Service, including any personal data;'),
    sub('(d) be solely responsible for the accuracy, quality and legality of Customer Data.'),
    clause('4.2', 'The Customer shall not:'),
    sub('(a) resell, sublicense or make the Service available to any third party;'),
    sub('(b) reverse engineer the Service except to the extent permitted by law;'),
    sub('(c) use the Service to store or process data in breach of any law;'),
    sub('(d) attempt to gain unauthorised access to the Service or its infrastructure;'),
    sub('(e) use the Service to build a competing product.'),

    h1('5.  DATA PROTECTION'),
    clause('5.1', 'Each party shall comply with the UK General Data Protection Regulation and the Data Protection Act 2018 ("Data Protection Laws").'),
    clause('5.2', 'Customer Data. Because analysis is performed in the Authorised User’s browser, the Supplier does not receive or store the contents of Customer Data files. Accordingly the Supplier is not a processor of Customer Data file contents, save in respect of:'),
    sub('(a) Derived Output saved to a dashboard, which the Supplier stores on its servers and which may contain aggregated figures derived from Customer Data; and'),
    sub('(b) information sent to the AI provider when AI Features are used, as described in Schedule 1 paragraph 4.'),
    p('In respect of (a) and (b), where that information contains personal data, the Customer is the controller and the Supplier is the processor, and Schedule 2 applies.', { indent: { left: 720 } }),
    clause('5.3', 'Account Data. In respect of Account Data the Supplier is the controller. The Supplier’s privacy notice at quickinsight.co.uk sets out how it is handled.'),
    clause('5.4', 'AI Features are opt-in. AI Features operate by default in a mode that transmits column names and data types only, and no data values. Any mode that transmits data values requires the Authorised User to give explicit in-product consent, and the Service allows the Authorised User to exclude individual columns and individual values before anything is sent. The Customer is responsible for deciding whether to permit its Authorised Users to enable such modes.'),
    clause('5.5', 'Sub-processors. The Supplier’s sub-processors are listed in Schedule 2 paragraph 6. The Supplier shall give the Customer [30] days’ notice before adding or replacing a sub-processor, and the Customer may terminate under clause 11.3 if it reasonably objects.'),
    clause('5.6', 'International transfers. Where the Supplier transfers personal data outside the UK it shall ensure an appropriate transfer mechanism under Data Protection Laws is in place.'),
    clause('5.7', 'Personal data breach. The Supplier shall notify the Customer without undue delay and in any event within [72] hours of becoming aware of a personal data breach affecting the Customer’s personal data.'),

    h1('6.  CONFIDENTIALITY'),
    clause('6.1', 'Each party shall keep confidential all non-public information disclosed by the other and use it only to perform this Agreement.'),
    clause('6.2', 'This does not apply to information that is public through no breach of this clause, was already known to the recipient, is independently developed, or must be disclosed by law.'),
    clause('6.3', 'This clause survives termination for [5] years.'),

    h1('7.  INTELLECTUAL PROPERTY'),
    clause('7.1', 'The Supplier owns all intellectual property rights in the Service. Nothing in this Agreement transfers those rights to the Customer.'),
    clause('7.2', 'The Customer owns all intellectual property rights in Customer Data and in Derived Output.'),
    clause('7.3', 'The Customer grants the Supplier a licence to use Customer Data and Derived Output only to the extent strictly necessary to provide the Service.'),
    clause('7.4', 'The Supplier may use anonymous, aggregated technical and usage statistics to operate and improve the Service, provided these cannot identify the Customer, any Authorised User, or any individual in Customer Data.'),

    h1('8.  WARRANTIES AND DISCLAIMERS'),
    clause('8.1', 'The Supplier warrants that it will provide the Service with reasonable care and skill.'),
    clause('8.2', 'Analytical output. The Customer acknowledges that:'),
    sub('(a) parts of the Service use artificial intelligence to interpret questions and generate database queries, and such systems can produce incorrect or incomplete results;'),
    sub('(b) the Customer is responsible for reviewing Derived Output before relying on it; and'),
    sub('(c) the Supplier gives no warranty that Derived Output is accurate, complete, or fit for any decision the Customer makes on the basis of it.'),
    clause('8.3', 'The Service is not a substitute for professional accounting, financial, legal, medical or regulatory advice, and must not be used as the sole basis for any decision with legal or regulatory consequence.'),
    clause('8.4', 'Except as expressly stated, all warranties, conditions and terms implied by statute or common law are excluded to the fullest extent permitted by law.'),
    clause('8.5', 'The Supplier does not warrant that the Service will be uninterrupted or error-free.'),

    h1('9.  LIMITATION OF LIABILITY'),
    clause('9.1', 'Nothing in this Agreement limits either party’s liability for death or personal injury caused by negligence, fraud or fraudulent misrepresentation, or any other liability that cannot lawfully be limited.'),
    clause('9.2', 'Subject to clause 9.1, neither party is liable for loss of profit, loss of business, loss of anticipated savings, loss or corruption of data, or any indirect or consequential loss.'),
    clause('9.3', 'Subject to clauses 9.1 and 9.2, each party’s total aggregate liability arising out of this Agreement is limited to the greater of (a) the total fees paid by the Customer in the twelve months preceding the claim, and (b) [£1,000].'),
    clause('9.4', 'The Customer acknowledges that the limits in this clause are reasonable given the price of the Service, and that it is responsible for maintaining its own backups of Customer Data.'),

    h1('10.  SUPPORT AND AVAILABILITY'),
    clause('10.1', 'The Supplier shall use reasonable endeavours to make the Service available [during UK business hours, 9am–5pm Monday to Friday, excluding public holidays].'),
    clause('10.2', 'The Supplier shall respond to support requests sent to [support@quickinsight.co.uk] within [2] business days.'),
    clause('10.3', 'No service level credits apply to this Agreement.'),

    h1('11.  TERM AND TERMINATION'),
    clause('11.1', 'This Agreement starts on the Effective Date and continues for [12] months ("Initial Term"), then renews automatically for successive [12]-month periods unless either party gives [60] days’ written notice.'),
    clause('11.2', 'Either party may terminate immediately on written notice if the other commits a material breach that is not remedied within [30] days of notice, or becomes insolvent.'),
    clause('11.3', 'The Customer may terminate on [30] days’ notice if it reasonably objects to a new sub-processor under clause 5.5.'),
    clause('11.4', 'On termination the Customer’s access to the Service ends. The Supplier shall delete Account Data and stored Derived Output within [30] days of termination, except where retention is required by law.'),
    clause('11.5', 'Clauses 6, 7, 8.2 to 8.5, 9, 11.4 and 14 survive termination.'),

    h1('12.  PUBLICITY AND REFERENCES'),
    clause('12.1', 'The Customer agrees that the Supplier may state publicly that the Customer uses the Service, and may use the Customer’s name and logo for that purpose on its website, in marketing materials, and in applications to funding bodies, awards and government schemes.'),
    clause('12.2', 'At the Supplier’s request, the Customer shall consider in good faith providing a written reference describing its use of the Service and the benefits it has obtained. The Customer is not obliged to provide one, and shall have final approval over any quotation attributed to it.'),
    clause('12.3', 'The Customer may withdraw the permission in clause 12.1 on [30] days’ written notice, save that the Supplier need not withdraw materials already submitted to a third party.'),

    h1('13.  FORCE MAJEURE'),
    clause('13.1', 'Neither party is liable for failure to perform caused by events beyond its reasonable control, including failures of internet or hosting infrastructure and failures of the third-party AI provider.'),

    h1('14.  GENERAL'),
    clause('14.1', 'Entire agreement. This Agreement is the entire agreement between the parties and supersedes all prior discussions.'),
    clause('14.2', 'Variation. No variation is effective unless in writing and signed by both parties.'),
    clause('14.3', 'Assignment. Neither party may assign this Agreement without the other’s written consent, not to be unreasonably withheld, save that the Supplier may assign it to a company it incorporates to carry on the QuickInsight business.'),
    clause('14.4', 'No partnership. Nothing creates a partnership, joint venture or employment relationship.'),
    clause('14.5', 'Third parties. No one other than the parties has any right to enforce this Agreement.'),
    clause('14.6', 'Notices. Notices shall be in writing and sent to the email addresses in the signature block.'),
    clause('14.7', 'Severance. If any provision is held invalid, the rest continues in force.'),
    clause('14.8', 'Governing law. This Agreement and any dispute arising from it is governed by the law of England and Wales, and the parties submit to the exclusive jurisdiction of the courts of England and Wales.'),
    new Paragraph({
        children: [new TextRun({
            text: 'If you are based in Scotland and would prefer to litigate locally, replace both '
                + 'references with "Scotland" and "the Scottish courts". Keep England and Wales if you '
                + 'want the most widely recognised choice for international counterparties.',
            italics: true, size: 19, color: '555566',
        })],
        spacing: { after: 240 }, indent: { left: 720 },
    }),

    h1('SIGNED BY THE PARTIES'),
    table([4513, 4513], [
        { head: true, cells: ['For the Supplier', 'For the Customer'] },
        { cells: ['Signature:', 'Signature:'] },
        { cells: ['', ''] },
        { cells: ['Name:  [YOUR FULL NAME]', 'Name:  [SIGNATORY NAME]'] },
        { cells: ['Title:  Sole trader trading as QuickInsight', 'Title:  [JOB TITLE]'] },
        { cells: ['Email:  [YOUR EMAIL]', 'Company:  [COMPANY NAME]'] },
        { cells: ['Date:', 'Email:  [EMAIL]'] },
        { cells: ['', 'Date:'] },
    ]),

    new Paragraph({ children: [new PageBreak()] }),

    /* ── Schedule 1 ── */
    title('SCHEDULE 1'),
    new Paragraph({
        children: [new TextRun({ text: 'DESCRIPTION OF THE SERVICE AND DATA FLOWS', bold: true, size: 24 })],
        alignment: AlignmentType.CENTER, spacing: { after: 300 },
    }),

    h1('1.  What the Service does'),
    p('QuickInsight is a business intelligence application for people who are not data specialists. '
        + 'Authorised Users load spreadsheet or CSV files, the Service cleans and profiles them '
        + 'automatically, and Authorised Users then ask questions either by assembling them in a '
        + 'guided question builder or by typing them in plain English.'),

    h1('2.  Where processing happens'),
    p('The Service loads Customer Data into an analytical database that runs inside the Authorised '
        + 'User’s web browser. Cleaning, profiling, query execution, charting and dashboard rendering '
        + 'all happen on the Authorised User’s own device. Customer Data files are not transmitted to '
        + 'the Supplier’s servers.'),

    h1('3.  What the Supplier’s servers do store'),
    table([2400, 6626], [
        { head: true, cells: ['Category', 'Detail'] },
        { boldFirst: true, cells: ['Account records', 'Name, email address, role, and a cryptographically hashed password'] },
        { boldFirst: true, cells: ['Usage logs', 'Timestamps and counts of AI requests, for quota enforcement'] },
        { boldFirst: true, cells: ['Dashboard configurations', 'Chart definitions, layout, filters and formatting. These may contain aggregated figures derived from Customer Data — for example a total or a category breakdown shown on a saved chart. They do not contain raw source rows.'] },
        { boldFirst: true, cells: ['Activity records', 'A log of actions taken in the application, associated with the user'] },
    ]),
    spacer(200),

    h1('4.  What is sent to the AI provider'),
    p('When an Authorised User uses AI Features, information is sent to the Supplier’s server, which '
        + 'forwards it to a third-party AI provider. The Service operates in one of two modes.'),
    h2('Standard mode (default)'),
    p('Only the structure of the data is sent: table names, column names, data types, and notes about '
        + 'how columns may be aggregated. No data values are sent.'),
    h2('Enhanced mode (opt-in)'),
    p('In addition to the above, a bounded list of distinct values from low-cardinality category '
        + 'columns may be sent, so that the AI can match a question’s wording to values that actually '
        + 'exist. This mode:'),
    bullet('requires the Authorised User to give explicit consent in the application before it takes effect;'),
    bullet('automatically excludes columns identified as identifiers, personal names, contact details, or sensitive categories;'),
    bullet('automatically excludes columns whose values do not look like categories;'),
    bullet('shows the Authorised User the exact list of values that would be sent; and'),
    bullet('allows the Authorised User to switch off any individual column or any individual value before sending.'),
    p('A preference alone is not sufficient to enable Enhanced mode. Absent recorded consent, the '
        + 'Service operates in Standard mode.'),
    new Paragraph({
        children: [
            new TextRun({ text: 'Never sent in either mode: ', bold: true }),
            new TextRun({ text: 'raw data rows, the source file, columns identified as personal or sensitive, and any value the Authorised User has switched off.' }),
        ],
        spacing: { after: 200 }, border: RULE,
    }),

    new Paragraph({ children: [new PageBreak()] }),

    /* ── Schedule 2 ── */
    title('SCHEDULE 2'),
    new Paragraph({
        children: [new TextRun({ text: 'DATA PROCESSING PARTICULARS', bold: true, size: 24 })],
        alignment: AlignmentType.CENTER, spacing: { after: 80 },
    }),
    new Paragraph({
        children: [new TextRun({ text: 'Required by Article 28(3) UK GDPR', italics: true, size: 20 })],
        alignment: AlignmentType.CENTER, spacing: { after: 300 },
    }),

    clause('1.', 'Subject matter and duration. Provision of the Service for the Term.'),
    clause('2.', 'Nature and purpose of processing. Storage of Account Data; storage of dashboard configurations containing aggregated Derived Output; transmission of data structure and, where consented, bounded category values to an AI provider for the purpose of generating database queries.'),
    clause('3.', 'Types of personal data.'),
    bullet('Account Data: name, email address, role, hashed password, activity records.'),
    bullet('Dashboard configurations: may contain aggregated figures derived from Customer Data. Personal data only where the Customer chooses to save a dashboard whose aggregates identify individuals.'),
    bullet('AI transmissions: column names and types in Standard mode. In Enhanced mode, additionally the distinct values of low-cardinality category columns that the Authorised User has not excluded and that the automatic filter has not removed.'),
    clause('4.', 'Categories of data subject. The Customer’s Authorised Users, and — only in the limited circumstances in paragraph 3 — individuals appearing in Customer Data.'),
    clause('5.', 'Duration of processing. For the Term, then deleted within [30] days of termination under clause 11.4.'),
    clause('6.', 'Sub-processors.'),
    table([2800, 3626, 2600], [
        { head: true, cells: ['Sub-processor', 'Purpose', 'Location'] },
        { cells: ['[HOSTING PROVIDER]', 'Application and database hosting', '[REGION]'] },
        { cells: ['OpenRouter', 'Routing of AI requests', '[REGION]'] },
        { cells: ['Google (Gemini models)', 'Generation of database queries from questions', '[REGION]'] },
    ]),
    new Paragraph({
        children: [new TextRun({
            text: 'Confirm each provider’s actual processing region and update this table before sending. '
                + 'An incorrect entry here is the kind of thing a customer’s IT function will catch.',
            italics: true, size: 19, color: '555566',
        })],
        spacing: { before: 140, after: 200 },
    }),
    clause('7.', 'Technical and organisational measures. Passwords stored using bcrypt; authentication by signed token; transport encrypted in transit; analytical processing performed client-side so that Customer Data file contents are not received by the Supplier; automatic exclusion of identifier, personal and sensitive columns from AI transmissions; per-column and per-value user control over AI transmissions; daily request quotas per user.'),

    new Paragraph({ children: [new PageBreak()] }),

    h1('NOTES FOR THE SUPPLIER — DELETE THIS PAGE BEFORE SENDING'),
    bullet('Clause 12 is the one that matters for evidence purposes. It gives you written permission to name the customer in an application to a government scheme. Do not delete it, and do not let a customer quietly strike it without noticing.'),
    bullet('Choose Option A or Option B in clause 3 and delete the other. Sending a document containing both looks unfinished.'),
    bullet('Fill in every highlighted placeholder. A returned contract with [£AMOUNT] still in it is worse than no contract.'),
    bullet('Send as PDF, not as an editable document.'),
    bullet('Ask for a signed scanned copy back. An emailed "yes we agree" is weaker.'),
    bullet('Update the Supplier party block and clause 14.3 once the company is incorporated. Existing signed agreements can be assigned to the new company under clause 14.3 without re-signing.'),
];

/* ════════════════════════════════════════════════════════════════════
   DOCUMENT 2 — INVOICE
   ════════════════════════════════════════════════════════════════════ */

const invoice = [
    new Paragraph({
        children: [new TextRun({ text: 'INVOICE', bold: true, size: 44, color: '1A1A2E' })],
        spacing: { after: 60 },
    }),
    new Paragraph({ text: '', border: RULE, spacing: { after: 240 } }),

    table([4513, 4513], [
        {
            cells: [
                ['[YOUR FULL LEGAL NAME]', 'trading as QuickInsight', '[YOUR ADDRESS LINE 1]', '[CITY, POSTCODE]', 'United Kingdom', '[YOUR EMAIL]', 'quickinsight.co.uk'],
                ['Invoice number:  [QI-2026-001]', 'Invoice date:  [DATE]', 'Supply date:  [PERIOD COVERED]', 'Payment due:  [DATE + 30 DAYS]'],
            ],
        },
    ]),
    spacer(280),

    new Paragraph({
        children: [new TextRun({ text: 'BILL TO', bold: true, size: 20, color: '555566' })],
        spacing: { after: 100 },
    }),
    p('[CUSTOMER COMPANY NAME]', { after: 40 }),
    p('[ADDRESS]', { after: 40 }),
    p('[COUNTRY]', { after: 40 }),
    p('Attn: [CONTACT NAME, JOB TITLE]', { after: 280 }),

    table([500, 4026, 2000, 1200, 1300], [
        { head: true, cells: ['#', 'Description', 'Period', 'Qty', 'Amount'], align: [null, null, null, AlignmentType.RIGHT, AlignmentType.RIGHT] },
        {
            cells: ['1', 'QuickInsight — software subscription, [N] users', '[1 Aug 2026 – 31 Jul 2027]', '1', '£[AMOUNT]'],
            align: [null, null, null, AlignmentType.RIGHT, AlignmentType.RIGHT],
        },
        { cells: ['', '', '', '', ''] },
    ]),
    spacer(160),

    table([5726, 2000, 1300], [
        { cells: ['', 'Subtotal', '£[AMOUNT]'], align: [null, AlignmentType.RIGHT, AlignmentType.RIGHT] },
        { cells: ['', 'VAT', 'Not applicable'], align: [null, AlignmentType.RIGHT, AlignmentType.RIGHT] },
        { cells: ['', 'TOTAL DUE', '£[AMOUNT]'], bold: true, shade: 'E8EAF0', align: [null, AlignmentType.RIGHT, AlignmentType.RIGHT] },
    ]),
    spacer(140),
    new Paragraph({
        children: [new TextRun({ text: 'Not VAT registered. No VAT has been charged.', italics: true, size: 20 })],
        spacing: { after: 320 },
    }),

    h1('Payment details'),
    table([2600, 6426], [
        { boldFirst: true, cells: ['Account name', '[YOUR NAME OR TRADING NAME]'] },
        { boldFirst: true, cells: ['Sort code', '[XX-XX-XX]'] },
        { boldFirst: true, cells: ['Account number', '[XXXXXXXX]'] },
        { boldFirst: true, cells: ['Reference', '[QI-2026-001]'] },
        { boldFirst: true, cells: ['IBAN (overseas)', '[IBAN]'] },
        { boldFirst: true, cells: ['BIC / SWIFT (overseas)', '[BIC]'] },
    ]),
    spacer(160),
    p('Payment terms: 30 days from the invoice date.'),

    new Paragraph({ children: [new PageBreak()] }),

    h1('Notes — delete this page before sending'),
    h2('What must appear on the invoice'),
    p('Legally required for a UK sole trader:'),
    bullet('The word "Invoice"'),
    bullet('A unique, sequential invoice number'),
    bullet('Your full legal name and your trading name'),
    bullet('Your address and contact details'),
    bullet('The customer’s name and address'),
    bullet('A clear description of what is being charged for'),
    bullet('The supply date (when the service was provided) and the invoice date'),
    bullet('The amount charged and the total due'),
    p('Because you are not VAT registered, the invoice must not show a VAT amount or a VAT number. '
        + 'Keep the line "Not VAT registered" so it is unambiguous.'),

    h2('Practical notes'),
    bullet('Number sequentially and never reuse a number. QI-2026-001, -002, and so on. Gaps and duplicates are what make an invoice set look constructed after the fact.'),
    bullet('Keep your records for 5 years after the 31 January submission deadline for the relevant tax year.'),
    bullet('Register for Self Assessment if you have not already — required once trading income passes £1,000 in a tax year.'),
    bullet('Overseas customers: invoice in GBP and let them handle conversion. The customer may be required to withhold tax in their own country; agree who bears that cost before invoicing.'),
    bullet('Send as PDF, and keep the sent email — it evidences the date.'),
    bullet('Keep the remittance advice or bank statement line showing the payment arriving. The invoice proves you asked; the statement proves they paid, and the second one is what carries weight.'),

    h2('Order of operations'),
    bullet('Agree the price with the customer by email — that email is your paper trail.'),
    bullet('Send the user agreement with Option A (paid) completed. Get it signed.'),
    bullet('Send the invoice referencing the agreement.'),
    bullet('Save: signed agreement, invoice PDF, and proof of payment received.'),
    p('Those three documents together are one complete evidence package per customer.'),
];

/* ── build ───────────────────────────────────────────────────────── */

function build(children, out) {
    const doc = new Document({ styles: baseStyles, numbering, sections: [{ properties: PAGE, children }] });
    return Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log('wrote', out); });
}

const DIR = process.argv[2] || '.';
Promise.all([
    build(agreement, `${DIR}/QuickInsight-User-Agreement.docx`),
    build(invoice, `${DIR}/QuickInsight-Invoice-Template.docx`),
]).catch(e => { console.error(e); process.exit(1); });
