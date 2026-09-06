import React, { useState } from 'react';
import { ArrowLeft, Shield, Cookie, FileText, Mail, Phone, MapPin, Clock, Send, ExternalLink, ChevronRight } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface LegalPageProps {
    onClose: () => void;
}

type LegalTab = 'privacy' | 'cookies' | 'terms' | 'contact';

interface ContactForm {
    name: string;
    email: string;
    subject: string;
    message: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const LAST_UPDATED = 'June 2025';
const CURRENT_YEAR = new Date().getFullYear();
const CONTACT_EMAIL = 'support@quickinsight.co.uk';
const WEBSITE = 'quickinsight.co.uk';

const TABS: { key: LegalTab; label: string; icon: React.ReactNode }[] = [
    { key: 'privacy',  label: 'Privacy Policy',     icon: <Shield className="w-4 h-4" /> },
    { key: 'cookies',  label: 'Cookies Policy',     icon: <Cookie className="w-4 h-4" /> },
    { key: 'terms',    label: 'Terms & Conditions', icon: <FileText className="w-4 h-4" /> },
    { key: 'contact',  label: 'Contact Us',         icon: <Mail className="w-4 h-4" /> },
];

/* ------------------------------------------------------------------ */
/*  Reusable tiny components                                           */
/* ------------------------------------------------------------------ */

const SectionTitle: React.FC<{ emoji: string; title: string }> = ({ emoji, title }) => (
    <h3 className="text-lg font-bold text-gray-900 mt-8 mb-3 flex items-center gap-2">
        <span>{emoji}</span> {title}
    </h3>
);

const SubSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="mb-4">
        <h4 className="text-sm font-bold text-gray-800 mb-1.5">{title}</h4>
        <div className="text-sm text-gray-600 leading-relaxed space-y-2">{children}</div>
    </div>
);

const Paragraph: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="text-sm text-gray-600 leading-relaxed mb-3">{children}</p>
);

const BulletList: React.FC<{ items: string[] }> = ({ items }) => (
    <ul className="list-disc list-inside text-sm text-gray-600 leading-relaxed space-y-1 ml-1 mb-3">
        {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
);

/* ------------------------------------------------------------------ */
/*  Privacy Policy                                                     */
/* ------------------------------------------------------------------ */

const PrivacyPolicy: React.FC = () => (
    <div>
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 mb-6">
            <p className="text-sm text-indigo-700 font-medium">
                🔒 Your privacy is fundamental to Astrabi Analytics. This policy explains how we collect, use, and protect your personal data in compliance with the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018.
            </p>
        </div>
        <Paragraph>Last updated: {LAST_UPDATED}</Paragraph>

        <SectionTitle emoji="📋" title="1. Data Controller" />
        <Paragraph>
            Astrabi Analytics (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) operates the QuickInsight platform at {WEBSITE}. We are the data controller responsible for your personal data. For any data protection enquiries, please contact us at <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline font-medium">{CONTACT_EMAIL}</a>.
        </Paragraph>

        <SectionTitle emoji="📦" title="2. Data We Collect" />
        <SubSection title="2.1 Account Information">
            <Paragraph>When you register, we collect your name, email address, and an encrypted password. This data is stored securely on our backend servers and is necessary for providing you access to the platform.</Paragraph>
        </SubSection>
        <SubSection title="2.2 Your Uploaded Data (Client-Side Processing)">
            <Paragraph>
                QuickInsight reads and queries uploaded CSV and Excel files <strong>within your web browser</strong>. The files and complete datasets are kept in browser storage, not uploaded for dashboard sync. Dashboard settings and optional AI features have the separate sharing boundaries described below.
            </Paragraph>
        </SubSection>
        <SubSection title="2.3 AI Feature Data">
            <Paragraph>When you use AI-powered features (Smart Insight, AI SQL), the following limited data may be sent to our backend proxy, which forwards requests to the OpenRouter LLM API:</Paragraph>
            <BulletList items={[
                'Smart Insight sends a rendered chart image, its title and chart context. Images can contain visible values, labels and personal information.',
                'AI SQL sends your question, query text and schema information. Values you include in questions or query filters can be present in this text.',
                'The AI SQL enhanced mode can additionally share selected category values after its privacy consent step. Private mode does not share these category catalogues.',
            ]} />
            <Paragraph>AI SQL privacy settings apply to AI SQL requests; they do not make the separate Smart Insight image feature local-only.</Paragraph>
        </SubSection>
        <SubSection title="2.4 PostgreSQL Connections">
            <Paragraph>PostgreSQL and SQL Server connectors operate through our backend. Connection credentials and query results pass through that backend during the active connection. These connectors have a different data path from local CSV and Excel analysis.</Paragraph>
        </SubSection>
        <SubSection title="2.5 Dashboard Sync Data">
            <Paragraph>Dashboard sync stores names, layouts, formatting, source references and saved query settings, including SQL and selected filters. Query text, titles and filters can contain values you chose. Sync excludes chart-result rows, KPI values, growth statistics, generated narratives, validation output and chart images. Complete results stay in browser storage. On another device, reopen the source file or reconnect the data source to rebuild the visuals.</Paragraph>
        </SubSection>

        <SectionTitle emoji="🎯" title="3. How We Use Your Data" />
        <BulletList items={[
            'To provide and maintain the QuickInsight platform',
            'To authenticate your identity and manage your account',
            'To process AI insight requests via our backend proxy',
            'To sync dashboard configurations across your sessions',
            'To communicate important service updates',
            'To respond to your support enquiries',
        ]} />

        <SectionTitle emoji="⚖️" title="4. Legal Basis for Processing" />
        <Paragraph>We process your data under the following lawful bases (UK GDPR Article 6):</Paragraph>
        <BulletList items={[
            'Contract performance — to provide the services you signed up for',
            'Legitimate interests — to improve and secure our platform',
            'Consent — for optional features like AI insights (you choose when to use them)',
        ]} />

        <SectionTitle emoji="🔐" title="5. Data Security" />
        <BulletList items={[
            'Authentication uses JWT (JSON Web Tokens) with secure token handling',
            'Passwords are hashed and salted before storage — we never store plain-text passwords',
            'All communications use HTTPS/TLS encryption',
            'Browser-side data processing means your datasets never traverse the network',
            'AI proxy requests are routed through our secure backend — your data is not sent directly to third-party AI providers',
        ]} />

        <SectionTitle emoji="🤝" title="6. Third-Party Data Sharing" />
        <Paragraph>We do not sell, rent, or trade your personal data. Limited data sharing occurs only with:</Paragraph>
        <BulletList items={[
            'OpenRouter LLM API — receives chart images and SQL queries when you use AI features (processed under their privacy policy)',
            'Infrastructure providers — for hosting and database services (under strict data processing agreements)',
        ]} />
        <Paragraph>We do not use any third-party analytics trackers, advertising networks, or social media tracking pixels.</Paragraph>

        <SectionTitle emoji="⏱️" title="7. Data Retention" />
        <BulletList items={[
            'Account data: retained while your account is active, deleted within 30 days of account deletion request',
            'Browser data (IndexedDB, localStorage): controlled entirely by you — clearing your browser data removes it',
            'Dashboard configurations: retained while your account is active',
            'AI request logs: automatically purged after 30 days',
        ]} />

        <SectionTitle emoji="✅" title="8. Your Rights (UK GDPR)" />
        <Paragraph>Under the UK GDPR, you have the following rights:</Paragraph>
        <BulletList items={[
            'Right of access — request a copy of your personal data',
            'Right to rectification — correct inaccurate personal data',
            'Right to erasure — request deletion of your personal data',
            'Right to data portability — receive your data in a structured, machine-readable format',
            'Right to restrict processing — limit how we use your data',
            'Right to object — object to processing based on legitimate interests',
            'Right to withdraw consent — for consent-based processing, at any time',
        ]} />
        <Paragraph>To exercise any of these rights, email us at <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline font-medium">{CONTACT_EMAIL}</a>. We will respond within 30 days.</Paragraph>

        <SectionTitle emoji="👶" title="9. Children's Privacy" />
        <Paragraph>QuickInsight is not intended for use by individuals under the age of 16. We do not knowingly collect personal data from children. If you believe a child has provided us with personal data, please contact us immediately.</Paragraph>

        <SectionTitle emoji="🔄" title="10. Changes to This Policy" />
        <Paragraph>We may update this privacy policy from time to time. Material changes will be notified via email or a prominent notice on the platform. Continued use after changes constitutes acceptance of the updated policy.</Paragraph>

        <SectionTitle emoji="📞" title="11. Contact & Complaints" />
        <Paragraph>
            For privacy-related enquiries or complaints, contact our Data Protection team at <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline font-medium">{CONTACT_EMAIL}</a>.
        </Paragraph>
        <Paragraph>You also have the right to lodge a complaint with the Information Commissioner's Office (ICO) at <a href="https://ico.org.uk" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline font-medium">ico.org.uk</a>.</Paragraph>
    </div>
);

/* ------------------------------------------------------------------ */
/*  Cookies Policy                                                     */
/* ------------------------------------------------------------------ */

const CookiesPolicy: React.FC = () => (
    <div>
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 mb-6">
            <p className="text-sm text-amber-700 font-medium">
                🍪 QuickInsight uses minimal browser storage — no third-party tracking cookies. This policy explains what we store and why.
            </p>
        </div>
        <Paragraph>Last updated: {LAST_UPDATED}</Paragraph>

        <SectionTitle emoji="📖" title="1. What Are Cookies & Browser Storage?" />
        <Paragraph>
            Cookies are small text files stored on your device. Modern web applications also use other browser storage mechanisms such as <strong>localStorage</strong> and <strong>IndexedDB</strong>. QuickInsight primarily uses these modern storage APIs rather than traditional cookies.
        </Paragraph>

        <SectionTitle emoji="🔑" title="2. Session Cookies (Essential)" />
        <Paragraph>We use essential session cookies for authentication:</Paragraph>
        <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                    <tr>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700 border-b">Storage Key</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700 border-b">Purpose</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700 border-b">Duration</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                    <tr>
                        <td className="px-4 py-2 font-mono text-xs text-indigo-600">qi_token</td>
                        <td className="px-4 py-2 text-gray-600">JWT authentication token</td>
                        <td className="px-4 py-2 text-gray-600">Session / until logout</td>
                    </tr>
                </tbody>
            </table>
        </div>
        <Paragraph>These are strictly necessary for the platform to function and cannot be disabled while using the service.</Paragraph>

        <SectionTitle emoji="💾" title="3. localStorage (Settings & Preferences)" />
        <Paragraph>We use your browser's localStorage to persist your application preferences locally:</Paragraph>
        <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                    <tr>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700 border-b">Data Stored</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700 border-b">Purpose</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                    <tr><td className="px-4 py-2 text-gray-600">Theme preference</td><td className="px-4 py-2 text-gray-600">Remember light/dark mode selection</td></tr>
                    <tr><td className="px-4 py-2 text-gray-600">Number & date formatting</td><td className="px-4 py-2 text-gray-600">Persist your locale and format choices</td></tr>
                    <tr><td className="px-4 py-2 text-gray-600">App state (Zustand stores)</td><td className="px-4 py-2 text-gray-600">Preserve UI state across page reloads</td></tr>
                    <tr><td className="px-4 py-2 text-gray-600">Authentication token</td><td className="px-4 py-2 text-gray-600">Keep you signed in between sessions</td></tr>
                </tbody>
            </table>
        </div>
        <Paragraph>Preferences and local result caches are stored in your browser. Authentication tokens accompany authenticated API requests, and dashboard settings are synced as described in the Privacy Policy.</Paragraph>

        <SectionTitle emoji="🗄️" title="4. IndexedDB (Dataset Storage)" />
        <Paragraph>
            Your uploaded datasets (CSV and Excel files) are stored in your browser's IndexedDB. This is a powerful browser-side database that allows QuickInsight to process your data locally using DuckDB-WASM without sending it to our servers.
        </Paragraph>
        <BulletList items={[
            'Datasets are stored entirely on your device',
            'Data persists until you manually delete it or clear your browser data',
            'Dashboard sync does not upload files or chart-result rows; separate AI features may share chart images or selected values as described in the Privacy Policy',
        ]} />

        <SectionTitle emoji="🚫" title="5. What We Do NOT Use" />
        <BulletList items={[
            'No third-party tracking cookies (Google Analytics, Facebook Pixel, etc.)',
            'No advertising cookies or retargeting',
            'No social media tracking pixels',
            'No cross-site tracking of any kind',
            'No fingerprinting or device identification technologies',
        ]} />

        <SectionTitle emoji="🧹" title="6. Managing & Clearing Your Data" />
        <Paragraph>You have full control over all browser-stored data:</Paragraph>
        <SubSection title="Clear All QuickInsight Data">
            <BulletList items={[
                'Open your browser\'s Developer Tools (F12)',
                'Go to Application → Storage',
                'Clear localStorage, IndexedDB, and cookies for quickinsight.co.uk',
                'Alternatively, use your browser\'s "Clear site data" option in Settings',
            ]} />
        </SubSection>
        <SubSection title="Selective Clearing">
            <BulletList items={[
                'To sign out: click the logout button — this removes your authentication token',
                'To remove datasets: delete individual datasets from the Data tab within the app',
                'To reset preferences: clear localStorage via browser Developer Tools',
            ]} />
        </SubSection>

        <SectionTitle emoji="🔄" title="7. Changes to This Policy" />
        <Paragraph>We may update this cookies policy as we add new features. The &quot;Last updated&quot; date will reflect any changes. Continued use of QuickInsight constitutes acceptance of the updated policy.</Paragraph>
    </div>
);

/* ------------------------------------------------------------------ */
/*  Terms & Conditions                                                 */
/* ------------------------------------------------------------------ */

const TermsAndConditions: React.FC = () => (
    <div>
        <div className="bg-violet-50 border border-violet-100 rounded-xl p-4 mb-6">
            <p className="text-sm text-violet-700 font-medium">
                📜 These terms govern your use of the QuickInsight platform operated by Astrabi Analytics. By using our service, you agree to these terms.
            </p>
        </div>
        <Paragraph>Last updated: {LAST_UPDATED}</Paragraph>

        <SectionTitle emoji="📌" title="1. Service Description" />
        <Paragraph>
            QuickInsight is a browser-based business intelligence and analytics platform that enables users to upload CSV/Excel data or connect to PostgreSQL databases, build interactive dashboards, run SQL queries, create visualisations, and receive AI-powered insights. The service is operated by Astrabi Analytics and is accessible at {WEBSITE}.
        </Paragraph>

        <SectionTitle emoji="👤" title="2. Account Terms" />
        <SubSection title="2.1 Registration">
            <BulletList items={[
                'You must provide accurate and complete information when creating an account',
                'You must be at least 16 years old to use the service',
                'You are responsible for maintaining the confidentiality of your password',
                'One person or legal entity per account — sharing accounts is not permitted',
            ]} />
        </SubSection>
        <SubSection title="2.2 Account Security">
            <Paragraph>You are responsible for all activity that occurs under your account. You must notify us immediately at <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline font-medium">{CONTACT_EMAIL}</a> if you suspect unauthorised access to your account.</Paragraph>
        </SubSection>
        <SubSection title="2.3 Guest Access">
            <Paragraph>Guest access provides view-only functionality with limited features. Guest users do not create a persistent account and cannot save dashboards to the cloud.</Paragraph>
        </SubSection>

        <SectionTitle emoji="✅" title="3. Acceptable Use" />
        <Paragraph>You agree to use QuickInsight only for lawful purposes. You must not:</Paragraph>
        <BulletList items={[
            'Upload or process any data you do not have the legal right to use',
            'Use the service to process sensitive personal data (e.g. health records, financial account numbers) without appropriate safeguards',
            'Attempt to reverse-engineer, decompile, or disassemble the platform',
            'Use the platform to develop a competing product or service',
            'Interfere with or disrupt the integrity or performance of the service',
            'Attempt to gain unauthorised access to systems or networks connected to the service',
            'Use automated scripts or bots to access the service without our written consent',
        ]} />

        <SectionTitle emoji="📊" title="4. Your Data & Responsibilities" />
        <SubSection title="4.1 Data Ownership">
            <Paragraph>You retain all rights and ownership of the data you upload to or analyse with QuickInsight. We claim no ownership or intellectual property rights over your data.</Paragraph>
        </SubSection>
        <SubSection title="4.2 Data Accuracy">
            <Paragraph>You are solely responsible for the accuracy, quality, and legality of the data you upload and process. QuickInsight provides analytical tools — the validity of insights depends on the quality of input data.</Paragraph>
        </SubSection>
        <SubSection title="4.3 Data Protection">
            <Paragraph>If you upload data containing personal information, you are the data controller for that data under UK GDPR. You must ensure you have a lawful basis for processing such data and comply with all applicable data protection legislation.</Paragraph>
        </SubSection>

        <SectionTitle emoji="🤖" title="5. AI Features Disclaimer" />
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
            <p className="text-sm text-amber-800 font-medium mb-2">⚠️ Important Notice About AI-Generated Insights</p>
            <p className="text-sm text-amber-700">
                AI-powered features (Smart Insight, AI SQL, Natural Language Queries) generate outputs using large language models. These outputs are <strong>approximate, probabilistic, and may contain errors</strong>.
            </p>
        </div>
        <BulletList items={[
            'AI insights are for informational purposes only and should not be solely relied upon for business, financial, medical, or legal decisions',
            'AI-generated SQL queries should be reviewed before execution — they may produce incorrect or unintended results',
            'We do not guarantee the accuracy, completeness, or reliability of any AI-generated content',
            'You should always verify AI outputs against your source data and domain expertise',
            'AI features do not constitute professional advice of any kind',
        ]} />

        <SectionTitle emoji="🏢" title="6. Intellectual Property" />
        <SubSection title="6.1 Our IP">
            <Paragraph>The QuickInsight platform, including its design, code, logos, documentation, and branding, is the intellectual property of Astrabi Analytics. All rights are reserved. You may not copy, modify, or distribute any part of the platform without written permission.</Paragraph>
        </SubSection>
        <SubSection title="6.2 Feedback">
            <Paragraph>If you provide suggestions, ideas, or feedback about the service, you grant us a non-exclusive, royalty-free, worldwide licence to use such feedback to improve our products and services.</Paragraph>
        </SubSection>

        <SectionTitle emoji="⚠️" title="7. Limitation of Liability" />
        <Paragraph>To the maximum extent permitted by law:</Paragraph>
        <BulletList items={[
            'QuickInsight is provided "as is" and "as available" without warranties of any kind, whether express or implied',
            'We do not warrant that the service will be uninterrupted, error-free, or free of harmful components',
            'We are not liable for any indirect, incidental, special, consequential, or punitive damages',
            'Our total liability for any claim arising from your use of the service shall not exceed the amount you paid us in the 12 months preceding the claim',
            'We are not responsible for any loss or corruption of data stored in your browser (IndexedDB, localStorage)',
        ]} />

        <SectionTitle emoji="🌐" title="8. Service Availability" />
        <BulletList items={[
            'We aim to maintain high availability but do not provide a formal Service Level Agreement (SLA)',
            'We may perform maintenance, updates, or modifications that temporarily affect availability',
            'We reserve the right to modify, suspend, or discontinue any feature with reasonable notice',
            'Browser-side features continue to work offline for previously loaded datasets',
        ]} />

        <SectionTitle emoji="💳" title="9. Payment Terms" />
        <Paragraph>If applicable to your plan:</Paragraph>
        <BulletList items={[
            'Fees are as stated at the time of purchase and may be updated with 30 days\' notice',
            'All fees are exclusive of VAT unless stated otherwise',
            'Refund requests are handled on a case-by-case basis',
        ]} />

        <SectionTitle emoji="🚪" title="10. Termination" />
        <BulletList items={[
            'You may close your account at any time by contacting us',
            'We may suspend or terminate your account if you breach these terms',
            'Upon termination, your right to use the service ceases immediately',
            'Data in your browser (IndexedDB, localStorage) remains until you clear it',
            'Server-side data (account info, dashboards) will be deleted within 30 days of account closure',
        ]} />

        <SectionTitle emoji="🏛️" title="11. Governing Law" />
        <Paragraph>These terms are governed by the laws of <strong>England and Wales</strong>. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.</Paragraph>

        <SectionTitle emoji="📝" title="12. Changes to These Terms" />
        <Paragraph>We may modify these terms at any time. Material changes will be communicated at least 30 days in advance via email or a notice on the platform. Continued use after the effective date constitutes acceptance. If you disagree with any changes, you should discontinue use and close your account.</Paragraph>

        <SectionTitle emoji="📬" title="13. Contact" />
        <Paragraph>For questions about these terms, please contact us at <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline font-medium">{CONTACT_EMAIL}</a>.</Paragraph>
    </div>
);

/* ------------------------------------------------------------------ */
/*  Contact Us                                                         */
/* ------------------------------------------------------------------ */

const ContactUs: React.FC = () => {
    const [form, setForm] = useState<ContactForm>({ name: '', email: '', subject: '', message: '' });
    const [submitted, setSubmitted] = useState(false);

    const subjectOptions = [
        'General Enquiry',
        'Technical Support',
        'Data Protection / Privacy',
        'Account Issues',
        'Feature Request',
        'Bug Report',
        'Partnership / Business',
        'Other',
    ];

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const subject = encodeURIComponent(form.subject || 'QuickInsight Enquiry');
        const body = encodeURIComponent(
            `Name: ${form.name}\nEmail: ${form.email}\n\n${form.message}`
        );
        window.open(`mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`, '_self');
        setSubmitted(true);
    };

    const updateField = (field: keyof ContactForm, value: string) =>
        setForm(prev => ({ ...prev, [field]: value }));

    return (
        <div>
            <div className="bg-green-50 border border-green-100 rounded-xl p-4 mb-6">
                <p className="text-sm text-green-700 font-medium">
                    💬 We&apos;d love to hear from you. Whether you have a question, feedback, or need support — reach out and we&apos;ll get back to you as soon as possible.
                </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Contact Form */}
                <div className="lg:col-span-2">
                    <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
                        <span>✉️</span> Send Us a Message
                    </h3>

                    {submitted ? (
                        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 text-center">
                            <div className="text-4xl mb-3">✅</div>
                            <h4 className="text-lg font-bold text-emerald-800 mb-2">Message Ready!</h4>
                            <p className="text-sm text-emerald-700 mb-4">
                                Your email client should have opened with your message pre-filled. If it didn&apos;t, please email us directly at{' '}
                                <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium underline">{CONTACT_EMAIL}</a>.
                            </p>
                            <button
                                onClick={() => { setSubmitted(false); setForm({ name: '', email: '', subject: '', message: '' }); }}
                                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-xl transition-colors"
                            >
                                Send Another Message
                            </button>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                        Your Name
                                    </label>
                                    <input
                                        type="text"
                                        value={form.name}
                                        onChange={e => updateField('name', e.target.value)}
                                        placeholder="John Doe"
                                        required
                                        className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                        Email Address
                                    </label>
                                    <input
                                        type="email"
                                        value={form.email}
                                        onChange={e => updateField('email', e.target.value)}
                                        placeholder="you@company.com"
                                        required
                                        className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all text-sm"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                    Subject
                                </label>
                                <select
                                    value={form.subject}
                                    onChange={e => updateField('subject', e.target.value)}
                                    required
                                    className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all text-sm appearance-none"
                                >
                                    <option value="" disabled>Select a subject…</option>
                                    {subjectOptions.map(opt => (
                                        <option key={opt} value={opt}>{opt}</option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                    Message
                                </label>
                                <textarea
                                    value={form.message}
                                    onChange={e => updateField('message', e.target.value)}
                                    placeholder="Tell us how we can help…"
                                    required
                                    rows={5}
                                    className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all text-sm resize-none"
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={!form.name.trim() || !form.email.trim() || !form.subject || !form.message.trim()}
                                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md"
                            >
                                <Send className="w-4 h-4" />
                                Send Message
                            </button>
                        </form>
                    )}
                </div>

                {/* Contact Info Sidebar */}
                <div className="space-y-6">
                    <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
                        <span>📍</span> Get in Touch
                    </h3>

                    <div className="space-y-4">
                        <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                            <Mail className="w-5 h-5 text-indigo-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</p>
                                <a href={`mailto:${CONTACT_EMAIL}`} className="text-sm text-indigo-600 hover:underline font-medium">{CONTACT_EMAIL}</a>
                            </div>
                        </div>

                        <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                            <MapPin className="w-5 h-5 text-indigo-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Address</p>
                                <p className="text-sm text-gray-700">Astrabi Analytics<br />United Kingdom</p>
                            </div>
                        </div>

                        <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                            <Clock className="w-5 h-5 text-indigo-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Business Hours</p>
                                <p className="text-sm text-gray-700">Monday — Friday<br />9:00 AM — 6:00 PM (GMT)</p>
                            </div>
                        </div>

                        <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                            <Phone className="w-5 h-5 text-indigo-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Response Time</p>
                                <p className="text-sm text-gray-700">We typically respond within<br />1–2 business days</p>
                            </div>
                        </div>
                    </div>

                    {/* Professional Links */}
                    <div className="pt-4 border-t border-gray-200">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Connect With Us</p>
                        <div className="space-y-2">
                            <a href={`https://${WEBSITE}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-gray-600 hover:text-indigo-600 transition-colors">
                                <ExternalLink className="w-4 h-4" /> {WEBSITE}
                            </a>
                            <a href="#" className="flex items-center gap-2 text-sm text-gray-600 hover:text-indigo-600 transition-colors">
                                <ChevronRight className="w-4 h-4" /> LinkedIn
                            </a>
                            <a href="#" className="flex items-center gap-2 text-sm text-gray-600 hover:text-indigo-600 transition-colors">
                                <ChevronRight className="w-4 h-4" /> Twitter / X
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Main LegalPage Component                                           */
/* ------------------------------------------------------------------ */

export const LegalPage: React.FC<LegalPageProps> = ({ onClose }) => {
    const [activeTab, setActiveTab] = useState<LegalTab>('privacy');

    const renderContent = () => {
        switch (activeTab) {
            case 'privacy':  return <PrivacyPolicy />;
            case 'cookies':  return <CookiesPolicy />;
            case 'terms':    return <TermsAndConditions />;
            case 'contact':  return <ContactUs />;
        }
    };

    return (
        <div className="fixed inset-0 z-[100] bg-gradient-to-br from-violet-50 via-white to-orange-50 overflow-y-auto">
            {/* ── Top Bar ── */}
            <div className="sticky top-0 z-30 bg-white/80 backdrop-blur-xl border-b border-gray-200">
                <div className="max-w-5xl mx-auto px-4 sm:px-6">
                    {/* Back button + branding row */}
                    <div className="flex items-center gap-3 py-3">
                        <button
                            onClick={onClose}
                            className="p-2 -ml-2 rounded-xl text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
                            title="Back to QuickInsight"
                        >
                            <ArrowLeft className="w-5 h-5" />
                        </button>
                        <div className="flex items-center gap-2">
                            <img src="/logo.jpg" alt="QuickInsight" className="w-7 h-7 rounded-lg object-cover shadow-sm" />
                            <span className="text-sm font-bold text-gray-900 hidden sm:inline">QuickInsight</span>
                            <span className="text-gray-300 hidden sm:inline">|</span>
                            <span className="text-sm text-gray-500 hidden sm:inline">Legal</span>
                        </div>
                    </div>

                    {/* Tab Navigation */}
                    <div className="flex gap-1 overflow-x-auto pb-0 -mb-px scrollbar-none">
                        {TABS.map(tab => (
                            <button
                                key={tab.key}
                                onClick={() => setActiveTab(tab.key)}
                                className={`
                                    flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium whitespace-nowrap
                                    border-b-2 transition-all rounded-t-lg
                                    ${activeTab === tab.key
                                        ? 'border-indigo-500 text-indigo-600 bg-indigo-50/50'
                                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                                    }
                                `}
                            >
                                {tab.icon}
                                <span className="hidden sm:inline">{tab.label}</span>
                                {/* Show shorter labels on mobile */}
                                <span className="sm:hidden">
                                    {tab.key === 'privacy' && 'Privacy'}
                                    {tab.key === 'cookies' && 'Cookies'}
                                    {tab.key === 'terms' && 'Terms'}
                                    {tab.key === 'contact' && 'Contact'}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* ── Content Area ── */}
            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
                <div className="bg-white border border-gray-200 rounded-2xl shadow-lg p-6 sm:p-8 lg:p-10">
                    {/* Page Title */}
                    <div className="mb-6 pb-4 border-b border-gray-100">
                        <h1 className="text-2xl font-bold text-gray-900">
                            {TABS.find(t => t.key === activeTab)?.label}
                        </h1>
                        <p className="text-sm text-gray-500 mt-1">
                            Astrabi Analytics — {WEBSITE} • Last updated: {LAST_UPDATED}
                        </p>
                    </div>

                    {/* Tab Content */}
                    {renderContent()}

                    {/* Footer */}
                    <div className="mt-12 pt-6 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-400">
                        <p>© {CURRENT_YEAR} Astrabi Analytics. All rights reserved.</p>
                        <div className="flex items-center gap-4">
                            <button onClick={() => setActiveTab('privacy')} className="hover:text-indigo-500 transition-colors">Privacy</button>
                            <button onClick={() => setActiveTab('cookies')} className="hover:text-indigo-500 transition-colors">Cookies</button>
                            <button onClick={() => setActiveTab('terms')} className="hover:text-indigo-500 transition-colors">Terms</button>
                            <button onClick={() => setActiveTab('contact')} className="hover:text-indigo-500 transition-colors">Contact</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default LegalPage;
