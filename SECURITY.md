# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@quickinsight.co.uk**
rather than opening a public issue.

Include what you found, how to reproduce it, and what an attacker could do with
it. You will get an acknowledgement within 5 working days and an assessment
within 15.

Please give a reasonable window to ship a fix before disclosing publicly. There
is no bug bounty — this is a small project — but credit is given in the release
notes unless you would rather stay anonymous.

## Where data lives

QuickInsight's analysis runs in the browser. A dataset loaded for analysis is
processed by an in-browser analytical database on the user's own machine and is
not uploaded to the server. The server stores account records, usage counts,
saved dashboard configurations, and activity logs.

When the AI features are used, requests are proxied through the backend so the
model provider API key stays server-side and never reaches the browser. By
default only the *structure* of the data is sent — table names, column names and
types. Sending sample values is opt-in, requires recorded consent, excludes
columns detected as identifiers, personal or sensitive, and can be narrowed by
the user per column and per value.

## Running this safely

The backend refuses to start in production without `JWT_SECRET`. No admin
account is created unless `ADMIN_EMAIL` and `ADMIN_PASSWORD` are both set, and
the password must be at least 12 characters. See `backend/.env.example`.

Never commit a real `.env`. `.gitignore` ignores every `.env` variant by default
and re-allows only the template and the public production file. Before pushing:

```bash
npm run scan:secrets
```

CI runs the same check on every push and pull request.

## History rewrite, August 2026

`backend/.env` and `backend/users.json` were previously committed, exposing an
API key and an admin password hash. Both files have been purged from all git
history and the affected credentials rotated. Clones made before this date
contain the old objects and should be deleted and re-cloned.
