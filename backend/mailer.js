/**
 * Account emails (password reset, invites), sent through Resend's HTTP API.
 *
 * Configure on the server:
 *   RESEND_API_KEY   the API key from resend.com
 *   MAIL_FROM        e.g. "QuickInsight <no-reply@quickinsight.co.uk>" (a verified domain)
 *
 * Without a key the email is not sent. Outside production the message is
 * printed to the server log so the flow can be tested end to end; in
 * production nothing secret is ever logged.
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function mailConfigured() {
    return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

/** Send one email. Resolves to { sent: true } or { sent: false, reason }. Never throws. */
async function sendEmail({ to, subject, text, html }) {
    if (!mailConfigured()) {
        if (!IS_PRODUCTION) {
            console.log(`[Mail] (not configured — printed instead)\nTo: ${to}\nSubject: ${subject}\n\n${text}`);
        } else {
            console.warn(`[Mail] Not sent: RESEND_API_KEY / MAIL_FROM are not set (subject: ${subject})`);
        }
        return { sent: false, reason: 'not_configured' };
    }
    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}) }),
        });
        if (!response.ok) {
            console.error('[Mail] Send failed:', response.status, (await response.text().catch(() => '')).slice(0, 300));
            return { sent: false, reason: 'provider_error' };
        }
        return { sent: true };
    } catch (error) {
        console.error('[Mail] Send failed:', error.message);
        return { sent: false, reason: 'network_error' };
    }
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** A short, plain email with one button. */
function simpleEmail({ heading, lines, buttonText, buttonUrl, footer }) {
    const text = [heading, '', ...lines, '', `${buttonText}: ${buttonUrl}`, '', footer].join('\n');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2937">
<h2 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h2>
${lines.map(line => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px">${escapeHtml(line)}</p>`).join('\n')}
<p style="margin:24px 0"><a href="${escapeHtml(buttonUrl)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(buttonText)}</a></p>
<p style="font-size:13px;color:#6b7280;margin:0">${escapeHtml(footer)}</p></div>`;
    return { text, html };
}

module.exports = { sendEmail, simpleEmail, mailConfigured };
