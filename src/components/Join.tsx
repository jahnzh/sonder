// Join (#582; spec #572, "Sign in, Request an account, Join"; boards Join.dc.html and JoinExpired.dc.html). `/join`
// stays the one real path (ADR 0020). The username comes from the invite as a fact; Create account signs in and lands
// on the Library. A link that does not work shows the server's message as the Title and the way to sign in.
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib";
import { Button } from "../parts/Button";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { busyIcon, FieldError, PasswordField, rememberAccount, SignInPage, type Account } from "./SignIn";

type Verified = { username: string; email: string };

/** The server's message about a link (404/410 in server/invites.ts) as a Title, which ends without a full stop. */
export function linkTitle(message: string) {
  return message.trim().replace(/\.$/, "");
}

// A link that cannot be activated: missing, unknown, malformed, expired or already used.
function JoinError({ message }: { message: string }) {
  return (
    <>
      <h1 className="signin-title type-title">{linkTitle(message)}</h1>
      <p className="signin-lead type-body">Ask the administrator for a new link.</p>
      <Button kind="secondary" className="signin-main" onClick={() => location.assign("/")}>
        Go to sign in
      </Button>
    </>
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
      const status = await api<{ required: boolean; user: Account }>("/auth/status");
      await rememberAccount(status.user, status.required);
      onActivated(status.user);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Could not create the account. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  if (!invite && verifyError)
    return (
      <SignInPage>
        <JoinError message={verifyError} />
      </SignInPage>
    );
  return (
    <SignInPage>
      <h1 className="signin-title type-title">Create your account</h1>
      {!invite && (
        <p className="signin-lead type-body" role="status">
          Checking your invite…
        </p>
      )}
      {invite && (
        <>
          <Group label="Your invite" note="From your invite.">
            <Row label="Username" value={invite.username} />
          </Group>
          <form className="signin-form" noValidate onSubmit={submit}>
            <PasswordField
              id="join-password"
              label="Password"
              value={password}
              show={show}
              onShowChange={setShow}
              onChange={(next) => {
                setPassword(next);
                setServerError("");
              }}
              autoComplete="new-password"
              required
              autoFocus
              invalid={attempted && !!passwordErr}
              describedBy="join-error"
              hint="At least 8 characters."
              error={attempted ? passwordErr : undefined}
            />
            <PasswordField
              id="join-confirm"
              label="Confirm password"
              value={confirm}
              show={show}
              onChange={(next) => {
                setConfirm(next);
                setServerError("");
              }}
              autoComplete="new-password"
              required
              invalid={attempted && !!confirmErr}
              describedBy="join-error"
              error={attempted ? confirmErr : undefined}
            />
            <div id="join-error" className="signin-alert" role="alert">
              {serverError && <FieldError>{serverError}</FieldError>}
            </div>
            <Button kind="primary" type="submit" className="signin-main" aria-busy={busy} icon={busy ? busyIcon : undefined}>
              {busy ? "Creating account" : "Create account"}
            </Button>
          </form>
        </>
      )}
    </SignInPage>
  );
}
