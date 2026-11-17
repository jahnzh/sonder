// Settings › Account (board SettingsAccount.dc.html): Username and Role; the administrator's password is set on the
// server, anyone else changes theirs here (POST /api/auth/password); Sign out when signing in is required.
import { useState } from "react";
import type { Account } from "../../components/SignIn";
import { api, authDB } from "../../lib";
import { Button } from "../../parts/Button";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";

type Notify = (text: string, error?: boolean) => void;

export const ADMIN_PASSWORD_LINE = "The administrator’s password is set on the server.";

/** Signs out on the server, forgets the session on this device and reloads into Sign in. */
export async function signOut(onLogout: () => void) {
  await api("/auth/logout", { method: "POST" });
  await authDB.preferences.put({ key: "auth", value: { required: true, authenticated: false } });
  navigator.serviceWorker?.controller?.postMessage("clear-stream-cache");
  onLogout();
  window.location.reload();
}

export function AccountPage({ user, needsPassword, onLogout, notify }: { user: Account; needsPassword: boolean; onLogout: () => void; notify: Notify }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // The first account is the administrator whose password is APP_PASSWORD, in the server's environment.
  const passwordOnServer = user.id === 1;
  const change = async () => {
    setBusy(true);
    try {
      await api("/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword("");
      setNewPassword("");
      notify("Password changed.");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Group label="Account" note={passwordOnServer ? ADMIN_PASSWORD_LINE : undefined}>
        <Row label="Username" value={user.username} />
        <Row label="Role" value={user.role === "admin" ? "Administrator" : "User"} />
      </Group>
      {!passwordOnServer && (
        <form
          className="settings-form-group"
          onSubmit={(event) => {
            event.preventDefault();
            void change();
          }}
        >
          <Group caption="Password">
            <li className="part-row-item settings-field">
              <label>
                <span className="type-body">Current password</span>
                <input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
              </label>
            </li>
            <li className="part-row-item settings-field">
              <label>
                <span className="type-body">New password</span>
                <input type="password" autoComplete="new-password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              </label>
            </li>
          </Group>
          <Button kind="secondary" type="submit" disabled={busy}>
            Change password
          </Button>
        </form>
      )}
      {needsPassword && (
        <Button
          kind="secondary"
          className="settings-sign-out"
          onClick={() => void signOut(onLogout).catch((error: Error) => notify(error.message, true))}
        >
          Sign out
        </Button>
      )}
    </>
  );
}
