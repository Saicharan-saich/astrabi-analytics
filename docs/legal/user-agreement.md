# QuickInsight — User Agreement

**Template — must be reviewed by a solicitor before use.** This is a working draft
prepared from the actual architecture of the application. It is not legal advice.
The data-protection schedule in particular should be checked by someone qualified
in UK GDPR before you send it to a customer.

Placeholders are marked `[LIKE THIS]`. Fill every one before sending.

---

## AGREEMENT FOR THE SUPPLY OF SOFTWARE AS A SERVICE

**This Agreement is dated** `[DATE]`

### BETWEEN

**(1) `[YOUR FULL LEGAL NAME]`**, a sole trader trading as **QuickInsight**, of
`[YOUR ADDRESS]`, United Kingdom ("**the Supplier**"); and

**(2) `[CUSTOMER COMPANY NAME]`**, a company registered in `[COUNTRY]` under
company number `[NUMBER]`, whose registered office is at `[ADDRESS]`
("**the Customer**").

> Once QuickInsight is incorporated, replace party (1) with:
> *"QuickInsight Ltd, a company registered in England and Wales under company
> number [NUMBER], whose registered office is at [ADDRESS]"*.

---

## 1. DEFINITIONS

1.1 In this Agreement:

**"Agreement"** means these terms together with all Schedules.

**"Authorised User"** means an employee, contractor or agent of the Customer
whom the Customer permits to use the Service.

**"Account Data"** means data the Supplier holds about the Customer and its
Authorised Users, as listed in Schedule 2.

**"Customer Data"** means the files, spreadsheets, databases and other data the
Customer loads into the Service for analysis.

**"Derived Output"** means charts, dashboards, aggregated figures, SQL queries
and narrative insights produced by the Service from Customer Data.

**"Effective Date"** means the date at the head of this Agreement.

**"Service"** means the QuickInsight software-as-a-service application made
available at quickinsight.co.uk, described in Schedule 1.

**"AI Features"** means those parts of the Service that send information to a
third-party large language model provider, as described in Schedule 1
paragraph 4.

---

## 2. THE SERVICE

2.1 The Supplier grants the Customer a non-exclusive, non-transferable right for
its Authorised Users to access and use the Service for the Customer's internal
business purposes for the Term.

2.2 The Service is delivered over the internet. The Customer is responsible for
its own internet access, browsers and devices.

2.3 **How the Service processes data.** The Service performs its analysis inside
the Authorised User's web browser using an in-browser analytical database.
Customer Data files are **not uploaded to, transmitted to, or stored by the
Supplier**, save for the specific and limited exceptions set out in Schedule 1
paragraphs 3 and 4. The Customer acknowledges that this architecture is a
material feature of the Service.

2.4 The Supplier may update the Service from time to time. The Supplier will not
make an update that materially reduces the Service's functionality or weakens
the data-handling position described in Schedule 1 without giving the Customer
`[30]` days' written notice.

---

## 3. FEES

**Option A — paid subscription** *(delete whichever does not apply)*

3.1 The Customer shall pay the Supplier `[£AMOUNT]` per `[month / year]` for up
to `[N]` Authorised Users.

3.2 The Supplier shall invoice `[monthly / annually] in advance`. Invoices are
payable within `[30]` days of the invoice date.

3.3 All fees are exclusive of VAT. The Supplier is `[not currently / ]`
VAT-registered and will `[not charge / charge]` VAT accordingly.

3.4 Fees may be increased once in any twelve-month period on `[60]` days'
written notice.

**Option B — no-charge evaluation** *(delete whichever does not apply)*

3.1 The Service is provided free of charge for an evaluation period of `[90]`
days from the Effective Date ("**Evaluation Period**").

3.2 During the Evaluation Period the Customer shall provide the Supplier with
reasonable feedback on the Service, including at least one written summary of
its experience at the end of the period.

3.3 After the Evaluation Period the parties may agree paid terms in writing. If
they do not, either party may terminate under clause 11.

---

## 4. CUSTOMER OBLIGATIONS

4.1 The Customer shall:

(a) ensure Authorised Users comply with this Agreement;

(b) keep account credentials confidential and notify the Supplier promptly of
any suspected unauthorised access;

(c) ensure it has the lawful right to process all Customer Data it loads into
the Service, including any personal data;

(d) be solely responsible for the accuracy, quality and legality of Customer
Data.

4.2 The Customer shall not:

(a) resell, sublicense or make the Service available to any third party;

(b) reverse engineer the Service except to the extent permitted by law;

(c) use the Service to store or process data in breach of any law;

(d) attempt to gain unauthorised access to the Service or its infrastructure;

(e) use the Service to build a competing product.

---

## 5. DATA PROTECTION

5.1 Each party shall comply with the UK General Data Protection Regulation and
the Data Protection Act 2018 ("**Data Protection Laws**").

5.2 **Customer Data.** Because analysis is performed in the Authorised User's
browser, the Supplier does not receive or store the contents of Customer Data
files. Accordingly the Supplier is not a processor of Customer Data file
contents, save in respect of:

(a) **Derived Output saved to a dashboard**, which the Supplier stores on its
servers and which may contain aggregated figures derived from Customer Data;
and

(b) **information sent to the AI provider** when AI Features are used, as
described in Schedule 1 paragraph 4.

In respect of (a) and (b), where that information contains personal data, the
Customer is the controller and the Supplier is the processor, and Schedule 2
applies.

5.3 **Account Data.** In respect of Account Data the Supplier is the controller.
The Supplier's privacy notice at quickinsight.co.uk sets out how it is handled.

5.4 **AI Features are opt-in.** AI Features operate by default in a mode that
transmits column names and data types only, and no data values. Any mode that
transmits data values requires the Authorised User to give explicit in-product
consent, and the Service allows the Authorised User to exclude individual
columns and individual values before anything is sent. The Customer is
responsible for deciding whether to permit its Authorised Users to enable such
modes.

5.5 **Sub-processors.** The Supplier's sub-processors are listed in Schedule 2
paragraph 6. The Supplier shall give the Customer `[30]` days' notice before
adding or replacing a sub-processor, and the Customer may terminate under
clause 11.3 if it reasonably objects.

5.6 **International transfers.** Where the Supplier transfers personal data
outside the UK it shall ensure an appropriate transfer mechanism under Data
Protection Laws is in place.

5.7 **Personal data breach.** The Supplier shall notify the Customer without
undue delay and in any event within `[72]` hours of becoming aware of a personal
data breach affecting the Customer's personal data.

---

## 6. CONFIDENTIALITY

6.1 Each party shall keep confidential all non-public information disclosed by
the other and use it only to perform this Agreement.

6.2 This does not apply to information that is public through no breach of this
clause, was already known to the recipient, is independently developed, or must
be disclosed by law.

6.3 This clause survives termination for `[5]` years.

---

## 7. INTELLECTUAL PROPERTY

7.1 The Supplier owns all intellectual property rights in the Service. Nothing
in this Agreement transfers those rights to the Customer.

7.2 The Customer owns all intellectual property rights in Customer Data and in
Derived Output.

7.3 The Customer grants the Supplier a licence to use Customer Data and Derived
Output only to the extent strictly necessary to provide the Service.

7.4 The Supplier may use anonymous, aggregated technical and usage statistics to
operate and improve the Service, provided these cannot identify the Customer,
any Authorised User, or any individual in Customer Data.

---

## 8. WARRANTIES AND DISCLAIMERS

8.1 The Supplier warrants that it will provide the Service with reasonable care
and skill.

8.2 **Analytical output.** The Customer acknowledges that:

(a) parts of the Service use artificial intelligence to interpret questions and
generate database queries, and such systems can produce incorrect or incomplete
results;

(b) the Customer is responsible for reviewing Derived Output before relying on
it; and

(c) **the Supplier gives no warranty that Derived Output is accurate, complete,
or fit for any decision the Customer makes on the basis of it.**

8.3 The Service is not a substitute for professional accounting, financial,
legal, medical or regulatory advice, and must not be used as the sole basis for
any decision with legal or regulatory consequence.

8.4 Except as expressly stated, all warranties, conditions and terms implied by
statute or common law are excluded to the fullest extent permitted by law.

8.5 The Supplier does not warrant that the Service will be uninterrupted or
error-free.

---

## 9. LIMITATION OF LIABILITY

9.1 Nothing in this Agreement limits either party's liability for death or
personal injury caused by negligence, fraud or fraudulent misrepresentation, or
any other liability that cannot lawfully be limited.

9.2 Subject to clause 9.1, neither party is liable for loss of profit, loss of
business, loss of anticipated savings, loss or corruption of data, or any
indirect or consequential loss.

9.3 Subject to clauses 9.1 and 9.2, each party's total aggregate liability
arising out of this Agreement is limited to the greater of (a) the total fees
paid by the Customer in the twelve months preceding the claim, and (b)
`[£1,000]`.

9.4 The Customer acknowledges that the limits in this clause are reasonable
given the price of the Service, and that it is responsible for maintaining its
own backups of Customer Data.

---

## 10. SUPPORT AND AVAILABILITY

10.1 The Supplier shall use reasonable endeavours to make the Service available
`[during UK business hours, 9am–5pm Monday to Friday, excluding public
holidays]`.

10.2 The Supplier shall respond to support requests sent to
`[support@quickinsight.co.uk]` within `[2]` business days.

10.3 No service level credits apply to this Agreement.

---

## 11. TERM AND TERMINATION

11.1 This Agreement starts on the Effective Date and continues for `[12]` months
("**Initial Term**"), then renews automatically for successive `[12]`-month
periods unless either party gives `[60]` days' written notice.

11.2 Either party may terminate immediately on written notice if the other
commits a material breach that is not remedied within `[30]` days of notice, or
becomes insolvent.

11.3 The Customer may terminate on `[30]` days' notice if it reasonably objects
to a new sub-processor under clause 5.5.

11.4 On termination the Customer's access to the Service ends. The Supplier
shall delete Account Data and stored Derived Output within `[30]` days of
termination, except where retention is required by law.

11.5 Clauses 6, 7, 8.2 to 8.5, 9, 11.4 and 14 survive termination.

---

## 12. PUBLICITY AND REFERENCES

12.1 The Customer agrees that the Supplier may state publicly that the Customer
uses the Service, and may use the Customer's name and logo for that purpose on
its website, in marketing materials, and in applications to funding bodies,
awards and government schemes.

12.2 At the Supplier's request, the Customer shall consider in good faith
providing a written reference describing its use of the Service and the benefits
it has obtained. The Customer is not obliged to provide one, and shall have
final approval over any quotation attributed to it.

12.3 The Customer may withdraw the permission in clause 12.1 on `[30]` days'
written notice, save that the Supplier need not withdraw materials already
submitted to a third party.

---

## 13. FORCE MAJEURE

13.1 Neither party is liable for failure to perform caused by events beyond its
reasonable control, including failures of internet or hosting infrastructure and
failures of the third-party AI provider.

---

## 14. GENERAL

14.1 **Entire agreement.** This Agreement is the entire agreement between the
parties and supersedes all prior discussions.

14.2 **Variation.** No variation is effective unless in writing and signed by
both parties.

14.3 **Assignment.** Neither party may assign this Agreement without the other's
written consent, not to be unreasonably withheld, save that the Supplier may
assign it to a company it incorporates to carry on the QuickInsight business.

14.4 **No partnership.** Nothing creates a partnership, joint venture or
employment relationship.

14.5 **Third parties.** No one other than the parties has any right to enforce
this Agreement.

14.6 **Notices.** Notices shall be in writing and sent to the email addresses in
the signature block.

14.7 **Severance.** If any provision is held invalid, the rest continues in
force.

14.8 **Governing law.** This Agreement and any dispute arising from it is
governed by the law of England and Wales, and the parties submit to the
exclusive jurisdiction of the courts of England and Wales.

> If you are based in Scotland and would prefer to litigate locally, replace
> both references with "Scotland" and "the Scottish courts". Keep England and
> Wales if you want the most widely recognised choice for international
> counterparties.

---

## SIGNED BY THE PARTIES

**For the Supplier**

Signature: ............................................

Name: `[YOUR FULL NAME]`

Title: Sole trader trading as QuickInsight

Email: `[YOUR EMAIL]`

Date: ............................................

**For the Customer**

Signature: ............................................

Name: `[SIGNATORY NAME]`

Title: `[JOB TITLE]`

Company: `[COMPANY NAME]`

Email: `[EMAIL]`

Date: ............................................

---

# SCHEDULE 1 — DESCRIPTION OF THE SERVICE AND DATA FLOWS

## 1. What the Service does

QuickInsight is a business intelligence application for people who are not
data specialists. Authorised Users load spreadsheet or CSV files, the Service
cleans and profiles them automatically, and Authorised Users then ask questions
either by assembling them in a guided question builder or by typing them in
plain English.

## 2. Where processing happens

The Service loads Customer Data into an analytical database that runs **inside
the Authorised User's web browser**. Cleaning, profiling, query execution,
charting and dashboard rendering all happen on the Authorised User's own device.
Customer Data files are not transmitted to the Supplier's servers.

## 3. What the Supplier's servers do store

| Category | Detail |
|---|---|
| Account records | Name, email address, role, and a cryptographically hashed password |
| Usage logs | Timestamps and counts of AI requests, for quota enforcement |
| Dashboard configurations | Chart definitions, layout, filters and formatting. **These may contain aggregated figures derived from Customer Data** — for example a total or a category breakdown shown on a saved chart. They do not contain raw source rows. |
| Activity records | A log of actions taken in the application, associated with the user |

## 4. What is sent to the AI provider

When an Authorised User uses AI Features, information is sent to the Supplier's
server, which forwards it to a third-party AI provider. The Service operates in
one of two modes:

**Standard mode (default).** Only the structure of the data is sent: table
names, column names, data types, and notes about how columns may be aggregated.
**No data values are sent.**

**Enhanced mode (opt-in).** In addition to the above, a bounded list of distinct
values from low-cardinality category columns may be sent, so that the AI can
match a question's wording to values that actually exist. This mode:

- requires the Authorised User to give explicit consent in the application
  before it takes effect;
- automatically excludes columns identified as identifiers, personal names,
  contact details, or sensitive categories;
- automatically excludes columns whose values do not look like categories;
- shows the Authorised User the exact list of values that would be sent; and
- allows the Authorised User to switch off any individual column or any
  individual value before sending.

A preference alone is not sufficient to enable Enhanced mode. Absent recorded
consent, the Service operates in Standard mode.

**Never sent in either mode:** raw data rows, the source file, columns
identified as personal or sensitive, and any value the Authorised User has
switched off.

---

# SCHEDULE 2 — DATA PROCESSING PARTICULARS

*Required by Article 28(3) UK GDPR.*

**1. Subject matter and duration.** Provision of the Service for the Term.

**2. Nature and purpose of processing.** Storage of Account Data; storage of
dashboard configurations containing aggregated Derived Output; transmission of
data structure and, where consented, bounded category values to an AI provider
for the purpose of generating database queries.

**3. Types of personal data.**

- *Account Data:* name, email address, role, hashed password, activity records.
- *Dashboard configurations:* may contain aggregated figures derived from
  Customer Data. Personal data only where the Customer chooses to save a
  dashboard whose aggregates identify individuals.
- *AI transmissions:* column names and types in Standard mode. In Enhanced mode,
  additionally the distinct values of low-cardinality category columns that the
  Authorised User has not excluded and that the automatic filter has not
  removed.

**4. Categories of data subject.** The Customer's Authorised Users, and — only
in the limited circumstances in paragraph 3 — individuals appearing in Customer
Data.

**5. Duration of processing.** For the Term, then deleted within `[30]` days of
termination under clause 11.4.

**6. Sub-processors.**

| Sub-processor | Purpose | Location |
|---|---|---|
| `[HOSTING PROVIDER]` | Application and database hosting | `[REGION]` |
| OpenRouter | Routing of AI requests | `[REGION]` |
| Google (Gemini models) | Generation of database queries from questions | `[REGION]` |

> Confirm each provider's actual processing region and update this table before
> sending. An incorrect entry here is the kind of thing a customer's IT function
> will catch.

**7. Technical and organisational measures.** Passwords stored using bcrypt;
authentication by signed token; transport encrypted in transit; analytical
processing performed client-side so that Customer Data file contents are not
received by the Supplier; automatic exclusion of identifier, personal and
sensitive columns from AI transmissions; per-column and per-value user control
over AI transmissions; daily request quotas per user.

---

## Notes for the Supplier — delete before sending

1. **Clause 12 is the one that matters for evidence purposes.** It gives you
   written permission to name the customer in an application to a government
   scheme. Do not delete it, and do not let a customer quietly strike it without
   noticing.
2. **Choose Option A or Option B in clause 3 and delete the other.** Sending a
   document containing both looks unfinished.
3. **Fill in every bracket.** A returned contract with `[£AMOUNT]` still in it is
   worse than no contract.
4. Send as PDF, not as an editable document.
5. Ask for a signed scanned copy back. An emailed "yes we agree" is weaker.
6. Update the Supplier party block and clause 14.3 once the company is
   incorporated. Existing signed agreements can be assigned to the new company
   under clause 14.3 without re-signing.
