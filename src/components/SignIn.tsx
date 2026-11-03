import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { ArrowRight, CircleAlert, CircleCheck, Eye, EyeOff, Loader2 } from "lucide-react";
import { api, authDB, selectUserStorage } from "../lib";
import { Dialog } from "./ui/dialog";
import "../signin.css";

export type Account = { id: number; username: string; role: "admin" | "user" };
export type AccountRequest = { id: number; email: string; username: string; note: string | null; createdAt: number };

// The server is authoritative (zod email check in server/account-requests.ts,
// the POST /api/users username rule). These mirrors reject the same malformed
// input early in the dialog; the email rule is slightly stricter (it demands
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

// Narration scenes for the decorative art: words per sentence row and seconds per sentence.
const scenes = {
  wide: { counts: [17, 19, 11, 21, 17, 10], durs: [6, 7, 4, 9, 8, 6], paraBreak: 3, perSec: 3.1, maxH: 52, wordScale: 1, start: 2 },
  compact: { counts: [8, 6, 9, 7], durs: [7, 4, 9, 8], paraBreak: 2, perSec: 2.9, maxH: 30, wordScale: 0.72, start: 1 },
};
const speed = 0.375;
const startAt = 0.4;

function useCompact() {
  const query = "(max-width: 700px)";
  const [compact, setCompact] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const change = () => setCompact(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return compact;
}

function SignInArt() {
  const scene = scenes[useCompact() ? "compact" : "wide"];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [cur, setCur] = useState(scene.start);
  const [advanced, setAdvanced] = useState(false);
  const seconds = scene.durs.map((d) => d * speed);
  useEffect(() => {
    setCur(scene.start);
    setAdvanced(false);
  }, [scene]);
  useEffect(() => {
    if (reduce) return;
    const left = advanced ? seconds[cur] : seconds[cur] * (1 - startAt);
    const timer = setTimeout(() => {
      setAdvanced(true);
      setCur((c) => (c + 1) % seconds.length);
    }, left * 1000);
    return () => clearTimeout(timer);
  }, [cur, advanced, reduce, scene]);

  const words: { key: string; style: CSSProperties; state?: string }[] = [];
  let k = 0;
  scene.counts.forEach((count, row) => {
    if (row === scene.paraBreak) {
      words.push({ key: `break-${row}`, style: { flex: "0 0 100%", height: 4 } });
      words.push({ key: `indent-${row}`, style: { flex: "0 0 var(--signin-indent)" } });
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
      <div className="signin-art-inner">
        <div className="signin-words">
          {words.map((w) => (
            <span key={w.key} className={w.state ? `signin-word ${w.state}` : undefined} style={w.style} />
          ))}
          <span style={{ flex: "1000 1 0" }} />
        </div>
        <div className="signin-wave">
          <div className="signin-brackets">
            {segments.map((s, i) => (
              <span key={i} className={s.on ? "on" : undefined} style={{ flex: `${s.dur} 1 0` }} />
            ))}
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
        </div>
      </div>
    </section>
  );
}

function RequestAccount({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [note, setNote] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [touched, setTouched] = useState({ email: false, username: false });
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [serverError, setServerError] = useState("");
  const emailErr = emailProblem(email.trim());
  const userErr = usernameProblem(username.trim());
  const close = () => {
    onOpenChange(false);
    // A reopened dialog starts fresh, including after a successful submission.
    setTimeout(() => {
      setEmail(""); setUsername(""); setNote(""); setHoneypot("");
      setTouched({ email: false, username: false });
      setAttempted(false); setSent(false); setServerError("");
    }, 0);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }} title="Request an account" description="The administrator reviews requests and will be in touch." className="account-dialog">
      {sent ? (
        <div className="signin-request-done" role="status">
          <CircleCheck size={28} aria-hidden="true" />
          <p>Your request has been received. Thank you!</p>
          <button type="button" className="signin-submit" onClick={close}>Done</button>
        </div>
      ) : (
        <form className="signin-form" noValidate onSubmit={submit}>
          <div className="signin-field">
            <label htmlFor="request-email">Email</label>
            <input
              id="request-email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              value={email}
              aria-invalid={(attempted || touched.email) && !!emailErr}
              aria-describedby={(attempted || touched.email) && emailErr ? "request-email-error" : undefined}
              onChange={(e) => { setEmail(e.target.value); setServerError(""); }}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              autoFocus
            />
            {(attempted || touched.email) && emailErr && (
              <p id="request-email-error" className="signin-error">
                <CircleAlert size={16} aria-hidden="true" />
                {emailErr}
              </p>
            )}
          </div>
          <div className="signin-field">
            <label htmlFor="request-username">Username</label>
            <input
              id="request-username"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              aria-invalid={(attempted || touched.username) && !!userErr}
              aria-describedby={(attempted || touched.username) && userErr ? "request-username-error" : undefined}
              onChange={(e) => { setUsername(e.target.value); setServerError(""); }}
              onBlur={() => setTouched((t) => ({ ...t, username: true }))}
            />
            {(attempted || touched.username) && userErr && (
              <p id="request-username-error" className="signin-error">
                <CircleAlert size={16} aria-hidden="true" />
                {userErr}
              </p>
            )}
          </div>
          <div className="signin-field">
            <label htmlFor="request-note">Note <span className="optional">optional</span></label>
            <textarea id="request-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {/* Hidden from people, visible to bots: a filled field marks an automated submission. */}
          <div className="signin-honeypot" aria-hidden="true">
            <label htmlFor="request-website">Website</label>
            <input id="request-website" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </div>
          <div id="request-error" role="alert">
            {serverError && (
              <p className="signin-error">
                <CircleAlert size={16} aria-hidden="true" />
                {serverError}
              </p>
            )}
          </div>
          <button type="submit" className="signin-submit" aria-busy={busy}>
            {busy ? (
              <>
                <Loader2 className="spin" size={20} aria-hidden="true" />
                Sending request
              </>
            ) : (
              <>
                Send request
                <ArrowRight size={18} aria-hidden="true" />
              </>
            )}
          </button>
        </form>
      )}
    </Dialog>
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
      const status = await api<{ user: Account }>("/auth/status");
      selectUserStorage(status.user.id, status.user.role);
      await authDB.preferences.put({ key: "auth", value: { required: true, authenticated: true, user: status.user } });
      window.dispatchEvent(new Event("sonder:authenticated"));
      onLogin(status.user);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="signin-page">
      <SignInArt />
      <section className="signin-panel">
        <div className="signin-content">
          <div className="signin-brand">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            sonder<span>®</span>
          </div>
          <h1>Sign in</h1>
          <form className="signin-form" onSubmit={submit}>
            <div className="signin-field">
              <label htmlFor="signin-username">Username</label>
              <input
                id="signin-username"
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
            <div className="signin-field">
              <label htmlFor="signin-password">Password</label>
              <div className="signin-password">
                <input
                  id="signin-password"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  aria-invalid={error}
                  aria-describedby="signin-error"
                  onChange={(e) => { setPassword(e.target.value); setError(false); }}
                />
                <button type="button" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} onClick={() => setShow(!show)}>
                  {show ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
                </button>
              </div>
            </div>
            <div id="signin-error" role="alert">
              {error && (
                <p className="signin-error">
                  <CircleAlert size={16} aria-hidden="true" />
                  Incorrect username or password
                </p>
              )}
            </div>
            <button type="submit" className="signin-submit" aria-busy={busy}>
              {busy ? (
                <>
                  <Loader2 className="spin" size={20} aria-hidden="true" />
                  Signing in
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight size={18} aria-hidden="true" />
                </>
              )}
            </button>
          </form>
          {needsPassword && (
            <button type="button" className="signin-request" onClick={() => setRequestOpen(true)}>
              Request an account
            </button>
          )}
        </div>
      </section>
      <RequestAccount open={requestOpen} onOpenChange={setRequestOpen} />
    </main>
  );
}
