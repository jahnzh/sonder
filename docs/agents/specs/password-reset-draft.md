# Draft: Self-service password reset via email

Status: **draft for the user's `/to-spec`** (2026-11-03). Synthesized from issue #20 (the
password-reset half, deferred by spec #166's Out of Scope), the landed invite lifecycle
(#167–#169, main `6b143d4`), and the current code. No interview — this is the pre-cooked
synthesis; `/to-spec` publishes it (or amends it) to the tracker with `ready-for-agent`.

## Problem Statement

Sonder accounts are invite-only, and a forgotten password currently has no self-service
recovery: the user must contact the administrator out-of-band, who then resets the password
in Settings and relays the new credentials manually. This is the same friction and
plaintext-credential risk that the account-request lifecycle (#166) removed for onboarding,
and it is the remaining unimplemented half of issue #20. Outbound transactional email now
exists (Resend, #168) with a proven, tested dispatch path (`sendResendEmail`), so the
infrastructure for a reset link is already in place.

## Solution

A self-service "Forgot your password?" flow that reuses the invite lifecycle's patterns end
to end: the user submits their account email on the sign-in screen, the server issues a
single-use, time-limited reset token (hashed at rest, like invite tokens) and emails a link
to `/reset?token=...`, and opening the link lets the user set a new password and signs them
in immediately. Accounts are addressed by email, which requires the user record to carry an
email: an additive `email` field on the user, set from the invite at claim time and
settable by the administrator in the user-management view for any existing account. The
administrator's manual password reset stays in place as the fallback for accounts without an
email or when delivery fails.

## User Stories

1. As a user who forgot their password, I want a "Forgot your password?" link on the sign-in
   screen, so that I can recover my account without contacting the administrator.
2. As a user who forgot their password, I want to submit only my account email through a
   clean dialog, so that recovery is as fast as the sign-in itself.
3. As a user who forgot their password, I want a clear receipt after submitting, so that I
   know a reset email is on its way.
4. As a user, I want the receipt wording not to reveal whether an account exists for the
   email I typed, so that my email address is not disclosed to someone guessing.
5. As a user with a reset email, I want the email to contain a direct link and say how long
   it is valid, so that I can complete the reset with confidence.
6. As a user opening my reset link, I want a dedicated page that asks me to choose and
   confirm a new password with the same validation I saw when I set it, so that the new
   credential is strong and typed correctly.
7. As a user who completed the reset, I want to be signed in and taken straight to my
   library, so that recovery feels seamless.
8. As a user who completed the reset, I want my other signed-in devices to be signed out, so
   that a stolen or shared session cannot keep working with the old password.
9. As a user whose link has expired or was already used, I want a clear, actionable error
   (expired / already used / invalid) with a path back to the sign-in screen, so that I
   understand what happened and can request a new link.
10. As a user whose reset email never arrives, I want the administrator's manual reset to
    remain available, so that a delivery hiccup never locks me out permanently.
11. As an administrator, I want to set and change the email on any user's account in the
    Users view, so that pre-existing accounts (and the admin account) can use self-service
    reset.
12. As an administrator, I want a clear error when I set an email that another account
    already uses, so that reset stays unambiguous and no email silently routes to two
    accounts.
13. As a user whose account is approved from an invite, I want my email stored on my
    account at activation, so that I can use self-service reset without any admin action.
14. As a server operator, I want reset requests rate-limited per IP and confirmations
    rate-limited per IP, so that the form and the reset endpoint cannot be abused to exhaust
    the Resend quota.
15. As a server operator, I want reset tokens cryptographically generated, stored only as
    hashes, single-use, and short-lived, so that a leaked token is unusable and a leaked
    database exposes no working reset links.
16. As a server operator, I want the flow to behave safely when Resend is unconfigured or a
    dispatch fails, so that the public form still answers normally and no account is
    affected.
17. As a server operator, I want new reset requests to invalidate that user's earlier
    unused reset tokens, so that at most one live link exists per account.
18. As an administrator of a multi-user instance, I want the admin account to participate in
    the same flow when it has an email, so that there is no privileged recovery side-channel
    to remember.

## Implementation Decisions

- **Module layout**: the reset flow lives beside the account-request/invite code in the
  users server module area (one new registration function, mirroring the invite routes), a
  new reset view component mirroring the join/activation view, and a small addition to the
  sign-in view (link + dialog, mirroring the request-an-account dialog).
- **Schema (additive only; both the runtime migration and the generated schema definition
  are updated, per the repository rule)**:
  - `users.email`: nullable text, indexed for lookup. Populated at invite claim (from the
    invite's email) and via the administrator's email field. No existing row is forced to
    have one.
  - `password_resets`: `id`, `token` (hashed, unique), `user_id`, `created_at`, `expires_at`,
    `used_at` (null until consumed). This mirrors the `account_invites` token lifecycle
    (hashed single-use token with expiry and claim columns) exactly.
- **Token security**: 32 random bytes, hex in the URL, stored only via the existing
  `hashToken` helper; single-use (consumption is a guarded update in the same transaction as
  the password change); 60-minute validity (a password reset, not a 7-day onboarding link).
  A new request for a user invalidates (marks used/expired) that user's unused tokens first.
- **Email uniqueness**: enforced at write time, not by a database constraint. Invite claim
  and the administrator's email setter both reject an email already held by a different
  account (clear 409-style error in the admin UI). This keeps reset lookups unambiguous
  without a destructive migration.
- **API contracts**:
  - `POST /api/password-reset/request` — public, IP rate-limited (5/hour). Body `{ email }`
    (email syntax check only). Always answers `200 { ok: true }` with the same receipt
    message whether or not an account exists (no enumeration). When a user with that email
    exists: invalidate prior unused tokens, create a token, and dispatch a Resend email with
    the `/reset?token=...` link (base URL from `APP_URL` with the same fallback behavior as
    invite links; the absence of a working delivery never affects the response).
  - `GET /api/password-reset/verify?token=...` — public. Returns `{ ok: true, username }`
    for a valid, unused, unexpired token; descriptive 400/404/410 errors otherwise (same
    error-shape convention as the invite verify endpoint).
  - `POST /api/password-reset/confirm` — public, IP rate-limited (10 per 15 minutes, same as
    invite claim). Body `{ token, password }` (shared password schema: min 8, max 512). In
    one transaction: consume the token (guarded update; failure = already used or invalid),
    set the password hash, delete the user's other sessions, and create a fresh session
    cookie — so a successful confirm signs the user in immediately, mirroring invite claim.
- **Admin UI**: the user-management view gains an email field per user (set/change), with
  the uniqueness error surfaced inline. The existing manual password reset is unchanged and
  remains the documented fallback.
- **User-facing UI**:
  - Sign-in view: "Forgot your password?" link below the form (same rendering condition as
    the request-an-account link), opening a dialog with the email field and receipt state.
  - Reset view at `/reset?token=...`: mirrors the join view — verifies the token, shows the
    username, password + confirm fields reusing the shared password field component, error
    card for expired/used/invalid links with a return-to-sign-in link, and on success hands
    the returned user to the app's signed-in flow.
- **Email content**: plain text, same shape as the invite email — subject names the
  purpose, body carries the link and the 60-minute validity note. Sent from `EMAIL_FROM`;
  dispatch uses `sendResendEmail`, whose unconfigured/failed paths report "not delivered"
  without throwing (the request endpoint's response is never affected).

## Testing Decisions

- **Philosophy**: external behavior through public interfaces only (the established
  convention from #166); the mocked Resend transport's recorded calls are the observable
  evidence of dispatch, exactly as the account-request/invite tests already do with their
  dispatch stub.
- **HTTP integration seam (Fastify inject)** — prior art: the users and
  account-request/invite test files:
  - request with an unknown email: same `200 { ok: true }` shape as a known email, and the
    dispatch stub records no call (no enumeration, no token side effects).
  - request with a known email: one dispatch recorded; the link in the body targets
    `/reset?token=...`.
  - a second request invalidates the first token: the first link's verify then fails, the
    second succeeds (at most one live link per account).
  - expiry: verify/confirm at the 60-minute boundary fail with the expired error (using the
    same mechanism the invite expiry tests use for their 7-day cutoff).
  - single use: confirm succeeds once; a second confirm with the same token fails.
  - confirm deletes the user's other sessions (a second context/cookie is refused after).
  - Resend unconfigured and dispatch-throwing: the request still answers `200 { ok: true }`.
  - email uniqueness: claim and admin-set both refuse an email held by another account.
  - rate limits: request and confirm limits trigger.
- **Browser end-to-end seam (Playwright)** — prior art: the account-requests spec (admin
  intercepts the Resend fetch to read the emailed link):
  - full journey: admin sets the QA user's email in Settings → user signs out → "Forgot your
    password?" → submit email → intercept the Resend call and open the emailed link → set a
    new password → automatically signed in on the user's shelf → the old password is refused
    on the sign-in form → a second browser context holding the old session cookie is signed
    out.
  - the expired/used link error card renders with the return-to-sign-in link.

## Out of Scope

- User self-service email change (email is admin-managed; changing it mid-flow is a later
  question with its own trust implications).
- Magic-link / passwordless sign-in, 2FA, SMS recovery, passkeys.
- Removing or changing the administrator's manual password reset (it is the fallback).
- Recovery for accounts without an email (admin-only by construction).
- Reset-link delivery to multiple accounts sharing one email (write-time uniqueness makes
  this impossible going forward; pre-existing duplicates, if any, keep using the admin
  fallback until their emails are made distinct).

## Further Notes

- Completes the password-reset half of issue #20 (the invite-request half landed with #166);
  the Resend domain `sonder.pecori.no` is verified, so delivery is expected to work in
  production after the `6b143d4` deploy.
- No new environment variables: reuses `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL` exactly as
  the invite flow does.
- Glossary candidate for `/grill-with-docs` or spec time: "Password reset link" (the
  single-use, 60-minute token URL), alongside the existing "Invite link".
- The `APP_URL`-unset fallback (email link points at localhost) is the same known behavior
  as the invite flow; production sets `APP_URL`, and the two flows should keep identical
  behavior rather than diverging.
