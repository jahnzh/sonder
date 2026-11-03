# Transactional email via Resend HTTPS API

We use Resend's HTTPS REST API for outbound transactional email (account request alerts and invite links) rather than self-hosting a Mail Transfer Agent (MTA) in homelab or using an SMTP socket transport.

## Context & Considered Options
Issue #20 evaluated self-hosting an MTA (e.g. Stalwart/Postfix) in homelab versus transactional relay providers. Self-hosting on residential IPs faces blocked outbound port 25 and IP reputation / spam deliverability penalties. Between SMTP and REST, Resend's HTTPS API (`api.resend.com/emails`) works natively via Node 24 `fetch` without socket connection dependencies, certificate handling, or firewall port 587/465 issues in Docker.

## Consequences
- Requires `RESEND_API_KEY` and verified sender domain (`EMAIL_FROM`).
- If unconfigured or delivery fails, account creation is not blocked: admins can view and manually copy generated invite links from Settings.
