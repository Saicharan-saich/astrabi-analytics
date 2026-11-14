/**
 * Database passwords for "reconnect without typing it again".
 *
 * The browser used to keep the SQL Server / PostgreSQL password in
 * sessionStorage so a dropped live connection could be re-opened. Now the
 * password stays on the server: it is encrypted (AES-256-GCM, with a key that
 * exists only in this process's memory) and the browser gets a random
 * reconnect ticket instead. A ticket works only for the account that made it,
 * expires after a few hours, and stops working on sign-out or a server restart
 * (then the person types the password again).
 */
const crypto = require('crypto');

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

function createConnectionVault({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), maxPerUser = 20 } = {}) {
    const key = crypto.randomBytes(32);
    const entries = new Map();

    const hashTicket = (ticket) => crypto.createHash('sha256').update(String(ticket)).digest('hex');

    function encrypt(text) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const data = Buffer.concat([cipher.update(String(text ?? ''), 'utf8'), cipher.final()]);
        return { iv, data, tag: cipher.getAuthTag() };
    }

    function decrypt({ iv, data, tag }) {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }

    function sweep() {
        const t = now();
        for (const [id, entry] of entries) if (entry.expiresAt <= t) entries.delete(id);
    }

    /** Keep a password for later; returns the ticket the browser holds. */
    function store(ownerUserId, kind, config, password) {
        sweep();
        const mine = [...entries.entries()].filter(([, e]) => e.ownerUserId === ownerUserId).sort((a, b) => a[1].createdAt - b[1].createdAt);
        while (mine.length >= maxPerUser) entries.delete(mine.shift()[0]);
        const ticket = crypto.randomBytes(32).toString('base64url');
        entries.set(hashTicket(ticket), {
            ownerUserId,
            kind,
            config: { ...config },
            secret: encrypt(password),
            createdAt: now(),
            expiresAt: now() + ttlMs,
        });
        return ticket;
    }

    /** The saved connection for this account's ticket, or null. */
    function open(ownerUserId, ticket) {
        if (!ticket || !ownerUserId) return null;
        sweep();
        const entry = entries.get(hashTicket(ticket));
        if (!entry || entry.ownerUserId !== ownerUserId) return null;
        try {
            return { kind: entry.kind, config: { ...entry.config }, password: decrypt(entry.secret) };
        } catch {
            return null;
        }
    }

    /** Forget one ticket, or every ticket of the account. */
    function forget(ownerUserId, ticket) {
        if (ticket) {
            const id = hashTicket(ticket);
            const entry = entries.get(id);
            if (entry && entry.ownerUserId === ownerUserId) entries.delete(id);
            return;
        }
        for (const [id, entry] of entries) if (entry.ownerUserId === ownerUserId) entries.delete(id);
    }

    return { store, open, forget, sweep, size: () => entries.size };
}

module.exports = { createConnectionVault, DEFAULT_TTL_MS };
