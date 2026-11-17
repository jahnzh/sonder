// The Server pages of Settings: Connections, Users, Library and storage. Until their own slice builds them in the
// new parts (#572 "Connections", "Users", "Library and storage"), each shows today's sections of the old long form,
// moved here unchanged: one page per row of the list. Someone who is not the administrator has Connections with
// Hardcover only.
import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, BookOpen, Check, Cloud, Compass, Copy, Headphones, KeyRound, Loader2, Plus, ShieldCheck, Trash2, UsersRound, Wifi } from "lucide-react";
import { ProwlarrSettings } from "../../components/ProwlarrSettings";
import { ReadingSyncSettings } from "../../components/ReadingSyncSettings";
import { HardcoverSyncSettings, hardcoverChanged } from "../../components/Hardcover";
import { SourceSettings } from "../../components/SourceWorkflow";
import { Dialog } from "../../components/ui/dialog";
import type { Account, AccountRequest } from "../../components/SignIn";
import { api } from "../../lib";
import type { Settings as SettingsData } from "../../types";

type Notify = (text: string, error?: boolean) => void;
type Props = { user: Account; settings: SettingsData | null; onSaved: () => void; notify: Notify };

function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** TorBox, Hardcover, AudioBookBay, Library Genesis and Prowlarr; Hardcover only for someone else. */
export function ConnectionsPage({ user, settings, onSaved, notify }: Props) {
  const admin = user.role === "admin";
  const [torbox, setTorbox] = useState("");
  const [hardcover, setHardcover] = useState("");
  const [abbUrl, setAbbUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (settings) setAbbUrl(settings.abbUrl);
  }, [settings]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify(admin ? { abbUrl, ...(torbox ? { torbox } : {}), ...(hardcover ? { hardcover } : {}) } : hardcover ? { hardcover } : {}),
      });
      setTorbox("");
      setHardcover("");
      onSaved();
      hardcoverChanged();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async (key: "torbox" | "hardcover") => {
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify({ [key]: "" }) });
      onSaved();
      notify("Connection removed.");
      if (key === "hardcover") hardcoverChanged();
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      await api("/torbox/test", { method: "POST" });
      notify("TorBox is connected and ready to play.");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="settings-legacy">
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        {admin && (
          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-section-icon green">
                <Cloud size={20} />
              </span>
              <div>
                <h2>TorBox</h2>
              </div>
              <span className={`connection-tag ${settings?.torboxConfigured ? "connected" : ""}`}>
                <span />
                {settings?.torboxConfigured ? "Connected" : "Not connected"}
              </span>
            </div>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                value={torbox}
                onChange={(event) => setTorbox(event.target.value)}
                placeholder={settings?.torboxConfigured ? "••••••••••••••••  ·  Saved securely" : "Paste your TorBox API key"}
              />
              <small>
                Find your key in{" "}
                <a href="https://torbox.app/settings" target="_blank" rel="noreferrer">
                  TorBox → Settings → API <ArrowUpRight size={12} />
                </a>
                . Save changes before testing.
              </small>
            </label>
            {settings?.torboxConfigured && (
              <div className="settings-inline-actions">
                <button type="button" className="button subtle" disabled={testing} onClick={() => void test()}>
                  {testing ? <Loader2 className="spin" size={14} /> : <Wifi size={14} />} Test connection
                </button>
                <button type="button" className="text-danger" onClick={() => void disconnect("torbox")}>
                  Disconnect
                </button>
              </div>
            )}
          </section>
        )}
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-section-icon lilac">
              <BookOpen size={20} />
            </span>
            <div>
              <h2>Hardcover</h2>
            </div>
            {settings?.hardcoverConfigured && (
              <span className="connection-tag connected">
                <span /> Connected
              </span>
            )}
          </div>
          <label>
            API token
            <input
              type="password"
              autoComplete="off"
              value={hardcover}
              onChange={(event) => setHardcover(event.target.value)}
              placeholder={settings?.hardcoverConfigured ? "••••••••••••••••  ·  Saved securely" : "Paste your Hardcover API token"}
            />
            <small>
              Get your token from{" "}
              <a href="https://hardcover.app/account/api" target="_blank" rel="noreferrer">
                Hardcover API settings <ArrowUpRight size={12} />
              </a>
              .
            </small>
          </label>
          {settings?.hardcoverConfigured && (
            <button className="text-danger" type="button" onClick={() => void disconnect("hardcover")}>
              Disconnect Hardcover
            </button>
          )}
        </section>
        {admin && (
          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-section-icon">
                <Compass size={20} />
              </span>
              <div>
                <h2>Discovery</h2>
              </div>
            </div>
            <label>
              AudioBookBay mirror
              <input type="url" value={abbUrl} onChange={(event) => setAbbUrl(event.target.value)} required placeholder="https://audiobookbay.lu" />
              <small>Use an HTTPS AudioBookBay mirror that is accessible from your server.</small>
            </label>
          </section>
        )}
        <div className="settings-save">
          <span>
            <ShieldCheck size={15} /> Connection keys are encrypted on your server.
          </span>
          <button className="button primary" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />} Save changes
          </button>
        </div>
      </form>
      <HardcoverSyncSettings configured={!!settings?.hardcoverConfigured} notify={notify} />
      {admin && (
        <>
          <SourceSettings settings={settings} onSaved={onSaved} notify={notify} />
          <ProwlarrSettings settings={settings} onSaved={onSaved} notify={notify} />
        </>
      )}
    </div>
  );
}

/** The accounts, the account requests and Add user (the administrator's). */
export function UsersPage({ user, notify, onChanged }: { user: Account; notify: Notify; onChanged: () => void }) {
  const [users, setUsers] = useState<Account[]>([]);
  const [requests, setRequests] = useState<AccountRequest[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetting, setResetting] = useState<Account | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [removing, setRemoving] = useState<Account | null>(null);
  const [actingRequestId, setActingRequestId] = useState<number | null>(null);
  const [approval, setApproval] = useState<{ username: string; link: string; delivered: boolean } | null>(null);
  const refresh = () =>
    api<Account[]>("/users")
      .then((list) => {
        setUsers(list);
        onChanged();
      })
      .catch((error) => notify(error.message, true));
  const refreshRequests = () => api<AccountRequest[]>("/account-requests").then(setRequests).catch((error) => notify(error.message, true));
  useEffect(() => {
    void refresh();
    void refreshRequests();
  }, [user.id]);
  const action = async (run: () => Promise<unknown>) => {
    try {
      await run();
      notify("Saved.");
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const reviewRequest = async (request: AccountRequest, decision: "approve" | "decline") => {
    setActingRequestId(request.id);
    try {
      if (decision === "decline") {
        await api(`/account-requests/${request.id}/decline`, { method: "POST" });
        setApproval(null);
        await refreshRequests();
        return;
      }
      const result = await api<{ ok: boolean; inviteLink: string; emailDelivered: boolean }>(`/account-requests/${request.id}/approve`, { method: "POST" });
      setApproval({ username: request.username, link: result.inviteLink, delivered: result.emailDelivered });
      await refreshRequests();
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setActingRequestId(null);
    }
  };
  const copyApprovalLink = async () => {
    if (!approval) return;
    try {
      await navigator.clipboard.writeText(approval.link);
      notify("Invite link copied.");
    } catch {
      notify("Could not copy the link.", true);
    }
  };
  const roleLabel = (account: Account) => (account.role === "admin" ? "Admin" : "User");
  return (
    <div className="settings-legacy">
      <section className="settings-section account-section">
        <div className="settings-section-heading">
          <span className="settings-section-icon">
            <UsersRound size={20} />
          </span>
          <div>
            <h2>Accounts</h2>
          </div>
        </div>
        <ul className="user-list">
          {users.map((account) => (
            <li key={account.id} className="user-row">
              <div className="user-row-name">
                <strong>{account.username}</strong>
                <span className="quiet-tag">{roleLabel(account)}</span>
              </div>
              {account.id !== 1 && (
                <div className="user-row-actions">
                  <button
                    type="button"
                    className="button subtle"
                    onClick={() => {
                      setResetPassword("");
                      setResetting(account);
                    }}
                  >
                    <KeyRound size={15} /> Reset password
                  </button>
                  <button type="button" className="button subtle user-remove" onClick={() => setRemoving(account)}>
                    <Trash2 size={15} /> Remove user
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <h3 className="requests-heading">Pending account requests</h3>
        {requests.length ? (
          <ul className="user-list">
            {requests.map((request) => (
              <li key={request.id} className="user-row request-row">
                <div className="user-row-name">
                  <strong>{request.username}</strong>
                  <span className="quiet-tag">{relativeTime(request.createdAt)}</span>
                </div>
                <div className="request-meta">
                  <span>{request.email}</span>
                  {request.note && <span className="request-note">{request.note}</span>}
                </div>
                <div className="user-row-actions">
                  <button type="button" className="button subtle" disabled={actingRequestId !== null} onClick={() => void reviewRequest(request, "decline")}>
                    Decline
                  </button>
                  <button type="button" className="button primary" disabled={actingRequestId !== null} onClick={() => void reviewRequest(request, "approve")}>
                    <Check size={15} /> Approve
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="requests-empty">No pending account requests.</p>
        )}
        {approval && (
          <div className="request-approval" role="status">
            <p>
              {approval.delivered
                ? `Approved ${approval.username}. The invite email was sent.`
                : `Approved ${approval.username}. The invite email was not sent. Copy the link and share it directly.`}
            </p>
            <code className="request-approval-link">{approval.link}</code>
            <button type="button" className="button subtle" onClick={() => void copyApprovalLink()}>
              <Copy size={15} /> Copy link
            </button>
          </div>
        )}
        <form
          className="account-form user-add"
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await api("/users", { method: "POST", body: JSON.stringify({ username, password, role: "user" }) });
              setUsername("");
              setPassword("");
            });
          }}
        >
          <h3>Add user</h3>
          <label>
            Username
            <input required value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
            <input type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button className="button primary">
            <Plus size={16} /> Add user
          </button>
        </form>
        <Dialog
          open={!!resetting}
          onOpenChange={(open) => {
            if (!open) setResetting(null);
          }}
          title={`Reset password for ${resetting?.username ?? ""}`}
          className="account-dialog"
        >
          <form
            className="account-form"
            onSubmit={(event) => {
              event.preventDefault();
              const account = resetting!;
              setResetting(null);
              void action(() => api(`/users/${account.id}`, { method: "PATCH", body: JSON.stringify({ password: resetPassword }) }));
            }}
          >
            <label>
              New password
              <input type="password" autoComplete="new-password" required autoFocus value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            </label>
            <div className="account-dialog-actions">
              <button type="button" className="button subtle" onClick={() => setResetting(null)}>
                Cancel
              </button>
              <button className="button primary">Reset password</button>
            </div>
          </form>
        </Dialog>
        <Dialog
          open={!!removing}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={`Remove ${removing?.username ?? ""}?`}
          className="account-dialog"
        >
          <div className="account-dialog-actions">
            <button type="button" className="button subtle" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button subtle user-remove"
              onClick={() => {
                const account = removing!;
                setRemoving(null);
                void action(() => api(`/users/${account.id}`, { method: "DELETE" }));
              }}
            >
              <Trash2 size={15} /> Remove user
            </button>
          </div>
        </Dialog>
      </section>
    </div>
  );
}

/** The library's name and the reading sync of every title (the administrator's). */
export function LibraryStoragePage({ settings, onSaved, notify }: Omit<Props, "user">) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings) setName(settings.name);
  }, [settings]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify({ name }) });
      onSaved();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-legacy">
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-section-icon">
              <Headphones size={20} />
            </span>
            <div>
              <h2>Library</h2>
            </div>
          </div>
          <label>
            Library name
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} placeholder="Library name" />
          </label>
          <div className="settings-inline-actions">
            <button className="button primary" disabled={busy}>
              {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />} Save
            </button>
          </div>
        </section>
      </form>
      <ReadingSyncSettings notify={notify} />
    </div>
  );
}
