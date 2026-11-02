import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, CircleAlert, Eye, EyeOff, Loader2 } from "lucide-react";
import { api, authDB, selectUserStorage } from "../lib";
import { SignInArt, type Account } from "./SignIn";
import "../signin.css";

type Verified = { username: string; email: string };

// The dedicated error card for a link that cannot be activated: missing,
// unknown, malformed, expired or already used. The messages come from the
// server (404/410 in server/invites.ts) and name the problem.
function JoinError({ message }: { message: string }) {
  return (
    <div className="join-error" role="alert">
      <CircleAlert size={28} aria-hidden="true" />
      <p>{message}</p>
      <a className="signin-request" href="/">
        Return to sign in
      </a>
    </div>
  );
}

export function Join({ onActivated }: { onActivated: (user: Account) => void }) {
  const token = new URLSearchParams(location.search).get("token");
  const [invite, setInvite] = useState<Verified | null>(null);
  const [verifyError, setVerifyError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  useEffect(() => {
    if (!token) {
      setVerifyError("This invite link is missing its token.");
      return;
    }
    let cancelled = false;
    void api<{ ok: boolean; username: string; email: string }>(`/invites/verify?token=${encodeURIComponent(token)}`)
      .then((result) => {
        if (!cancelled) setInvite({ username: result.username, email: result.email });
      })
      .catch((err) => {
        if (!cancelled)
          setVerifyError(err instanceof Error ? err.message : "Could not verify this invite link.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);
  const passwordErr =
    password.length < 8
      ? "Passwords are at least 8 characters."
      : password.length > 512
        ? "Passwords are at most 512 characters."
        : "";
  const confirmErr = confirm !== password || confirm === "" ? "Passwords don't match." : "";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !invite || !token) return;
    setAttempted(true);
    if (passwordErr || confirmErr) return;
    setBusy(true);
    setServerError("");
    try {
      await api<{ ok: true; user: Account }>("/invites/claim", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      // The same storage and auth-preference flow the sign-in page uses, so the
      // app picks up the new account exactly as after a login.
      const status = await api<{ required: boolean; user: Account }>("/auth/status");
      selectUserStorage(status.user.id, status.user.role);
      await authDB.preferences.put({
        key: "auth",
        value: { required: status.required, authenticated: true, user: status.user },
      });
      window.dispatchEvent(new Event("sonder:authenticated"));
      onActivated(status.user);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Could not create the account. Please try again.");
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
          <h1>Create your account</h1>
          {!invite && verifyError && <JoinError message={verifyError} />}
          {!invite && !verifyError && (
            <div className="join-loading" role="status">
              <Loader2 className="spin" size={22} aria-hidden="true" />
              <span>Checking your invite…</span>
            </div>
          )}
          {invite && (
            <form className="signin-form" noValidate onSubmit={submit}>
              <p className="join-intro">
                You’re invited as <strong>{invite.username}</strong>.
                <span className="join-email">{invite.email}</span>
              </p>
              <div className="signin-field">
                <label htmlFor="join-username">Username</label>
                <input
                  id="join-username"
                  className="join-username"
                  autoComplete="off"
                  spellCheck={false}
                  value={invite.username}
                  readOnly
                />
              </div>
              <div className="signin-field">
                <label htmlFor="join-password">Password</label>
                <div className="signin-password">
                  <input
                    id="join-password"
                    type={show ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    value={password}
                    aria-invalid={attempted && !!passwordErr}
                    aria-describedby="join-error"
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setServerError("");
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    aria-label={show ? "Hide password" : "Show password"}
                    aria-pressed={show}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
                  </button>
                </div>
                {attempted && passwordErr && (
                  <p className="signin-error">
                    <CircleAlert size={16} aria-hidden="true" />
                    {passwordErr}
                  </p>
                )}
              </div>
              <div className="signin-field">
                <label htmlFor="join-confirm">Confirm password</label>
                <div className="signin-password">
                  <input
                    id="join-confirm"
                    type={show ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    value={confirm}
                    aria-invalid={attempted && !!confirmErr}
                    aria-describedby="join-error"
                    onChange={(e) => {
                      setConfirm(e.target.value);
                      setServerError("");
                    }}
                  />
                  <button
                    type="button"
                    aria-label={show ? "Hide password" : "Show password"}
                    aria-pressed={show}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
                  </button>
                </div>
                {attempted && confirmErr && (
                  <p className="signin-error">
                    <CircleAlert size={16} aria-hidden="true" />
                    {confirmErr}
                  </p>
                )}
              </div>
              <div id="join-error" role="alert">
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
                    Creating account
                  </>
                ) : (
                  <>
                    Create account
                    <ArrowRight size={18} aria-hidden="true" />
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
