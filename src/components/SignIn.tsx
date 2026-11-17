// Sign in and Request an account (#582; spec #572, "Sign in, Request an account, Join"; boards SignIn.dc.html and
// SignInRequest.dc.html). No places and no player: Sonder's name, one Title, one main button, in one column that is
// at most 400 wide and centred on a desktop. Join (Join.tsx) is built from the same pieces.
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { api, authDB, selectUserStorage } from "../lib";
import { Button } from "../parts/Button";
import { Sheet } from "../parts/Sheet";
import "../signin.css";

export type Account = { id: number; username: string; role: "admin" | "user" };
export type AccountRequest = { id: number; email: string; username: string; note: string | null; createdAt: number };

/** Persist the signed-in account locally and notify the app shell. */
export async function rememberAccount(user: Account, required: boolean) {
  selectUserStorage(user.id, user.role);
  await authDB.preferences.put({
    key: "auth",
    value: { required, authenticated: true, user },
  });
  window.dispatchEvent(new Event("sonder:authenticated"));
}

/** The page around Sign in and Join: Sonder's name over one column. */
export function SignInPage({ children }: { children: ReactNode }) {
  return (
    <main className="signin-page">
      <div className="signin-column">
        <div className="signin-brand">
          <span className="signin-brand-mark" aria-hidden="true" />
          <span className="type-heading">Sonder</span>
        </div>
        {children}
      </div>
    </main>
  );
}

/** The busy spinner a main button shows in place of nothing. */
export const busyIcon = <Loader2 className="spin" aria-hidden="true" />;

/** A field's message: in the failed colour, read out when it appears. */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="signin-error type-label">
      {children}
    </p>
  );
}

export function PasswordField({
  id,
  label,
  value,
  show,
  onShowChange,
  onChange,
  autoComplete,
  autoFocus,
  required,
  invalid,
  describedBy,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  show: boolean;
  /** Draws Show password beside the field; a field without it follows another field's toggle. */
  onShowChange?: (show: boolean) => void;
  onChange: (value: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** The field's rule, under it. */
  hint?: string;
  error?: string;
}) {
  const input = (
    <input
      id={id}
      className="signin-input type-body"
      type={show ? "text" : "password"}
      autoComplete={autoComplete}
      required={required}
      value={value}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
      autoFocus={autoFocus}
    />
  );
  return (
    <div className="signin-field">
      <label htmlFor={id} className="type-label">
        {label}
      </label>
      {onShowChange ? (
        <div className="signin-password">
          {input}
          <Button
            kind="secondary"
            label={show ? "Hide password" : "Show password"}
            aria-pressed={show}
            icon={show ? <EyeOff /> : <Eye />}
            onClick={() => onShowChange(!show)}
          />
        </div>
      ) : (
        input
      )}
      {hint && <p className="signin-hint">{hint}</p>}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

// The server is authoritative (zod email check in server/account-requests.ts,
// the POST /api/users username rule). These mirrors reject the same malformed
// input early in the sheet; the email rule is slightly stricter (it demands
// a dotted domain and a two-letter TLD), so a few server-valid addresses are
// refused here rather than by the server.
const EMAIL_RULE = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const USERNAME_RULE = /^[a-z0-9._-]+$/i;
function emailProblem(email: string): string | null {
  return EMAIL_RULE.test(email) ? null : "Enter a valid email address.";
}
function usernameProblem(username: string): string | null {
  if (username.length < 2 || username.length > 40) return "Usernames are 2 to 40 characters.";
  if (!USERNAME_RULE.test(username)) return "Use letters, numbers, dots, dashes or underscores.";
  if (username.toLowerCase() === "admin") return "That username is reserved.";
  return null;
}

// The narration art: sentence rows of words with the one being read lit, over the waveform of its audio. Words per
// sentence row and seconds per sentence.
const scene = { counts: [8, 6, 9, 7], durs: [7, 4, 9, 8], paraBreak: 2, perSec: 2.9, maxH: 30, wordScale: 0.72, start: 1 };
const speed = 0.375;
const startAt = 0.4;

export function SignInArt() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [cur, setCur] = useState(scene.start);
  const [advanced, setAdvanced] = useState(false);
  const seconds = scene.durs.map((d) => d * speed);
  useEffect(() => {
    if (reduce) return;
    const left = advanced ? seconds[cur] : seconds[cur] * (1 - startAt);
    const timer = setTimeout(() => {
      setAdvanced(true);
      setCur((c) => (c + 1) % seconds.length);
    }, left * 1000);
    return () => clearTimeout(timer);
  }, [cur, advanced, reduce]);

  const words: { key: string; style: CSSProperties; state?: string }[] = [];
  let k = 0;
  scene.counts.forEach((count, row) => {
    if (row === scene.paraBreak) {
      words.push({ key: `break-${row}`, style: { flex: "0 0 100%", height: 0 } });
      words.push({ key: `indent-${row}`, style: { flex: "0 0 24px" } });
    }
    const state = row < cur ? "past" : row === cur ? "current" : "next";
    for (let i = 0; i < count; i++, k++) {
      const w = Math.round(scene.wordScale * (20 + ((k * 37) % 53) + (k % 7 === 3 ? 26 : 0)));
      words.push({ key: `w-${k}`, state, style: { flex: `1 1 ${w}px`, maxWidth: Math.round(w * 1.5) } });
    }
  });

  let b = 0;
  const segments = scene.durs.map((dur, row) => {
    const bars = Array.from({ length: Math.round(dur * scene.perSec) }, () => {
      const v = Math.abs(Math.sin(b * 0.53) * 0.55 + Math.sin(b * 0.19 + 1.1) * 0.3 + Math.sin(b * 1.7) * 0.15);
      b++;
      return Math.max(3, Math.round(4 + v * (scene.maxH - 4)));
    });
    return { dur, bars, on: row === cur };
  });
  const delay = !advanced && cur === scene.start ? -seconds[cur] * startAt : 0;

  return (
    <section className="signin-art" aria-hidden="true">
      <div className="signin-words">
        {words.map((w) => (
          <span key={w.key} className={w.state ? `signin-word ${w.state}` : undefined} style={w.style} />
        ))}
        <span style={{ flex: "1000 1 0" }} />
      </div>
      <div className="signin-bars">
        {segments.map((s, i) => (
          <div key={i} className={s.on ? "signin-segment on" : "signin-segment"} style={{ flex: `${s.dur} 1 0` }}>
            {s.bars.map((h, j) => (
              <span key={j} style={{ height: h }} />
            ))}
            {s.on && (
              <div
                key={`${cur}-${advanced}`}
                className="signin-playhead"
                style={{
                  animationDuration: `${seconds[cur]}s`,
                  animationDelay: `${delay}s`,
                  animationPlayState: reduce ? "paused" : "running",
                }}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Request an account: a sheet over Sign in with no address of its own (spec #572). */
export function RequestAccount({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [note, setNote] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [touched, setTouched] = useState({ email: false, username: false });
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [serverError, setServerError] = useState("");
  const emailField = useRef<HTMLInputElement>(null);
  // Email takes focus once the sheet has, so the sheet still knows what opened it (Request an account) and returns
  // focus there when it closes. The sheet's own effect runs before this one.
  useEffect(() => emailField.current?.focus({ preventScroll: true }), []);
  const emailErr = emailProblem(email.trim());
  const userErr = usernameProblem(username.trim());
  const showEmailErr = (attempted || touched.email) && !!emailErr;
  const showUserErr = (attempted || touched.username) && !!userErr;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setAttempted(true);
    if (emailErr || userErr) return;
    setBusy(true);
    setServerError("");
    try {
      await api("/account-requests", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), username: username.trim(), ...(note.trim() ? { note: note.trim() } : {}), honeypot }),
      });
      setSent(true);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Could not send your request. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Request an account"
      onClose={onClose}
      footer={
        sent ? (
          <Button kind="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button kind="primary" type="submit" form="request-form" aria-busy={busy} icon={busy ? busyIcon : undefined}>
            {busy ? "Sending request" : "Send request"}
          </Button>
        )
      }
    >
      <h1 className="signin-title type-title">Request an account</h1>
      {sent ? (
        <p className="signin-lead type-body" role="status">
          Your request has been received.
        </p>
      ) : (
        <>
          <p className="signin-lead type-label">The administrator reviews each request and sends an invite link by email.</p>
          <form id="request-form" className="signin-form" noValidate onSubmit={submit}>
            <div className="signin-field">
              <label htmlFor="request-email" className="type-label">
                Email
              </label>
              <input
                id="request-email"
                className="signin-input type-body"
                type="email"
                autoComplete="email"
                spellCheck={false}
                value={email}
                aria-invalid={showEmailErr}
                aria-describedby={showEmailErr ? "request-email-error" : undefined}
                onChange={(e) => { setEmail(e.target.value); setServerError(""); }}
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                ref={emailField}
              />
              {showEmailErr && <FieldError id="request-email-error">{emailErr}</FieldError>}
            </div>
            <div className="signin-field">
              <label htmlFor="request-username" className="type-label">
                Username
              </label>
              <input
                id="request-username"
                className="signin-input type-body"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                aria-invalid={showUserErr}
                aria-describedby={showUserErr ? "request-username-rule request-username-error" : "request-username-rule"}
                onChange={(e) => { setUsername(e.target.value); setServerError(""); }}
                onBlur={() => setTouched((t) => ({ ...t, username: true }))}
              />
              <p id="request-username-rule" className="signin-hint">
                Letters, numbers, dots, dashes or underscores.
              </p>
              {showUserErr && <FieldError id="request-username-error">{userErr}</FieldError>}
            </div>
            <div className="signin-field">
              <label htmlFor="request-note" className="type-label">
                Note <span className="signin-optional">optional</span>
              </label>
              <textarea id="request-note" className="signin-input type-body" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {/* Hidden from people, visible to bots: a filled field marks an automated submission. */}
            <div className="signin-honeypot" aria-hidden="true">
              <label htmlFor="request-website">Website</label>
              <input id="request-website" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
            </div>
            <div id="request-error" role="alert">
              {serverError && <FieldError>{serverError}</FieldError>}
            </div>
          </form>
        </>
      )}
    </Sheet>
  );
}

export function SignIn({ onLogin, needsPassword }: { onLogin: (user: Account) => void; needsPassword: boolean }) {
  const [requestOpen, setRequestOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const status = await api<{ required: boolean; user: Account }>("/auth/status");
      await rememberAccount(status.user, status.required);
      onLogin(status.user);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SignInPage>
      <SignInArt />
      <h1 className="signin-title type-title">Sign in</h1>
      <form className="signin-form" onSubmit={submit}>
        <div className="signin-field">
          <label htmlFor="signin-username" className="type-label">
            Username
          </label>
          <input
            id="signin-username"
            className="signin-input type-body"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            aria-invalid={error}
            aria-describedby="signin-error"
            onChange={(e) => { setUsername(e.target.value); setError(false); }}
            autoFocus
          />
        </div>
        <PasswordField
          id="signin-password"
          label="Password"
          value={password}
          show={show}
          onShowChange={setShow}
          onChange={(next) => { setPassword(next); setError(false); }}
          autoComplete="current-password"
          required
          invalid={error}
          describedBy="signin-error"
        />
        <div id="signin-error" className="signin-alert" role="alert">
          {error && <FieldError>Incorrect username or password</FieldError>}
        </div>
        <Button kind="primary" type="submit" className="signin-main" aria-busy={busy} icon={busy ? busyIcon : undefined}>
          {busy ? "Signing in" : "Sign in"}
        </Button>
      </form>
      {needsPassword && (
        <div className="signin-other">
          <Button kind="quiet" className="signin-link" onClick={() => setRequestOpen(true)}>
            Request an account
          </Button>
        </div>
      )}
      {requestOpen && <RequestAccount onClose={() => setRequestOpen(false)} />}
    </SignInPage>
  );
}
