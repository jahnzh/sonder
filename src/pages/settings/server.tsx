// The Server pages of Settings (#580; spec #572 "Connections", "Users", "Library and storage"; boards
// DesktopSettings.dc.html, SettingsUsers.dc.html, SettingsLibrary.dc.html), built from the parts. A switch or a
// choice saves when it changes; a text field (a key, an address, the library name) has its own Save. Connection
// keys are write-only: their field is empty and says "Saved" when one is set. Someone who is not the administrator
// has Connections with Hardcover only, and reaches neither Users nor Library and storage (the address resolves
// those to Settings).
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { hardcoverChanged, useHardcover } from "../../components/Hardcover";
import { Dialog } from "../../components/ui/dialog";
import type { Account, AccountRequest } from "../../components/SignIn";
import { api } from "../../lib";
import { Button } from "../../parts/Button";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import { Switch } from "../../parts/Switch";
import { InfoMark } from "../../parts/Tooltip";
import { savedPreferencesToFollow, type SyncPreferences } from "../../hardcover-sync-draft";
import {
  APPROVING_NOTE,
  KEYS_ENCRYPTED,
  MEDIA_DRIVE_CONNECTED,
  MEDIA_DRIVE_NOT_CONNECTED,
  NO_REQUESTS,
  SYNC_MODES,
  approvedLine,
  hardcoverSyncLine,
  requestAge,
  usedLine,
  usedShare,
} from "../../settings-server";
import { tip } from "../../tooltip-texts";
import type { HardcoverState, Settings as SettingsData } from "../../types";
import { ChoiceRow } from "./Choice";

type Notify = (text: string, error?: boolean) => void;
type Props = { user: Account; settings: SettingsData | null; onSaved: () => void; notify: Notify };

function PlusIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * A text field in a Group with its own Save: its label on the left, the field and Save on the right (under it on a
 * phone). `name` names the field and its Save ("Save TorBox API key"). A secret field is write-only: it starts
 * empty, says "Saved" when one is set, and empties after a save; any other field starts at the saved value.
 */
function FieldRow({
  label,
  name,
  type = "text",
  saved,
  secret,
  isSet,
  placeholder,
  required,
  maxLength,
  onSave,
}: {
  label: string;
  name: string;
  type?: "text" | "url" | "password";
  saved?: string;
  secret?: boolean;
  isSet?: boolean;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(secret ? "" : (saved ?? ""));
  const [busy, setBusy] = useState(false);
  // A field follows the saved value when it changes (another save, the settings read again).
  useEffect(() => {
    if (!secret) setValue(saved ?? "");
  }, [saved, secret]);
  const changed = secret ? value.trim() !== "" : value.trim() !== (saved ?? "");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    try {
      await onSave(value.trim());
      if (secret) setValue("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="part-row-item settings-field-row">
      <form className="settings-field-form" onSubmit={(event) => void submit(event)}>
        <label className="settings-field-label type-body" htmlFor={`settings-${name.replace(/\s+/g, "-").toLowerCase()}`}>
          {label}
        </label>
        <span className="settings-field-input">
          <input
            id={`settings-${name.replace(/\s+/g, "-").toLowerCase()}`}
            className="type-label"
            type={type}
            aria-label={name}
            autoComplete="off"
            value={value}
            required={required}
            maxLength={maxLength}
            placeholder={secret && isSet ? "Saved" : placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button kind="secondary" type="submit" aria-label={`Save ${name}`} disabled={!changed || busy}>
            Save
          </Button>
        </span>
      </form>
    </li>
  );
}

/** A Group item holding buttons (Test, Disconnect), on the right edge. */
function ActionsRow({ children }: { children: ReactNode }) {
  return <li className="part-row-item settings-actions-row">{children}</li>;
}

async function patchSettings(body: Record<string, string>) {
  await api("/settings", { method: "PATCH", body: JSON.stringify(body) });
}

/** TorBox, Hardcover, Prowlarr, AudioBookBay and Library Genesis; Hardcover only for someone else. */
export function ConnectionsPage({ user, settings, onSaved, notify }: Props) {
  const admin = user.role === "admin";
  const [testing, setTesting] = useState<"" | "torbox" | "prowlarr">("");
  // Saves one field; the settings are read again so the statuses follow.
  const save = (body: Record<string, string>, done = "Saved.") => async () => {
    try {
      await patchSettings(body);
      onSaved();
      notify(done);
    } catch (error) {
      notify((error as Error).message, true);
      throw error;
    }
  };
  const saveField = (key: string, done?: string) => (value: string) => save({ [key]: value }, done)().catch(() => {});
  const test = async (service: "torbox" | "prowlarr") => {
    setTesting(service);
    try {
      if (service === "torbox") {
        await api("/torbox/test", { method: "POST" });
        notify("TorBox is connected and ready to play.");
      } else {
        const result = await api<{ version: string; indexers: number }>("/prowlarr/test", { method: "POST" });
        notify(`Prowlarr ${result.version} is connected with ${result.indexers} torrent ${result.indexers === 1 ? "indexer" : "indexers"}.`);
      }
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setTesting("");
    }
  };
  return (
    <>
      {admin && (
        <Group caption="TorBox" info={<InfoMark name="TorBox" text={tip("torbox")} />}>
          <Row label="Status" value={settings?.torboxConfigured ? "Connected" : "Not connected"} />
          <FieldRow label="API key" name="TorBox API key" type="password" secret isSet={settings?.torboxConfigured} onSave={saveField("torbox", "TorBox key saved.")} />
          {settings?.torboxConfigured && (
            <ActionsRow>
              <Button kind="secondary" disabled={testing === "torbox"} onClick={() => void test("torbox")}>
                {testing === "torbox" ? "Testing…" : "Test"}
              </Button>
              <Button
                kind="quiet"
                className="settings-failed-action"
                aria-label="Disconnect TorBox"
                onClick={() => void save({ torbox: "" }, "Connection removed.")().catch(() => {})}
              >
                Disconnect
              </Button>
            </ActionsRow>
          )}
        </Group>
      )}
      <HardcoverConnection settings={settings} onSaved={onSaved} notify={notify} />
      {admin && (
        <>
          <Group caption="Prowlarr" info={<InfoMark name="Prowlarr" text={tip("prowlarr")} />}>
            <Row label="Status" value={settings?.prowlarrConfigured ? "Connected" : settings?.prowlarrUrl ? "Not connected" : "Not set up"} />
            <FieldRow label="Address" name="Prowlarr address" type="url" saved={settings?.prowlarrUrl ?? ""} placeholder="http://127.0.0.1:9696" onSave={saveField("prowlarrUrl")} />
            <FieldRow label="API key" name="Prowlarr API key" type="password" secret isSet={settings?.prowlarrConfigured} onSave={saveField("prowlarr", "Prowlarr key saved.")} />
            {(settings?.prowlarrConfigured || settings?.prowlarrUrl) && (
              <ActionsRow>
                <Button kind="secondary" disabled={testing === "prowlarr" || !settings?.prowlarrConfigured} aria-label="Test Prowlarr" onClick={() => void test("prowlarr")}>
                  {testing === "prowlarr" ? "Testing…" : "Test"}
                </Button>
                <Button
                  kind="quiet"
                  className="settings-failed-action"
                  aria-label="Disconnect Prowlarr"
                  onClick={() => void save({ prowlarr: "", prowlarrUrl: "" }, "Prowlarr removed.")().catch(() => {})}
                >
                  Disconnect
                </Button>
              </ActionsRow>
            )}
          </Group>
          <Group caption="AudioBookBay">
            <FieldRow label="Mirror address" name="AudioBookBay address" type="url" required saved={settings?.abbUrl ?? ""} placeholder="https://audiobookbay.lu" onSave={saveField("abbUrl")} />
          </Group>
          <Group caption="Library Genesis">
            <FieldRow label="Mirror address" name="Library Genesis address" type="url" required saved={settings?.libgenUrl ?? ""} placeholder="https://libgen.li" onSave={saveField("libgenUrl")} />
          </Group>
        </>
      )}
      <p className="part-group-note settings-page-note">{KEYS_ENCRYPTED}</p>
    </>
  );
}

/**
 * Hardcover: the token, the sync mode and Include my lists (each saved when chosen), and Sync now with the last
 * sync or the changes waiting (moved from the Library, #578). The mode and the lists switch are a draft that
 * follows the saved preferences only when those change (#422): a refresh of the Hardcover state that lands while
 * a pick is being saved leaves the pick shown.
 */
function HardcoverConnection({ settings, onSaved, notify }: Omit<Props, "user">) {
  const configured = !!settings?.hardcoverConfigured;
  const { state, refresh } = useHardcover();
  const [mode, setMode] = useState<HardcoverState["mode"]>("off");
  const [lists, setLists] = useState(true);
  const [busy, setBusy] = useState<"" | "sync" | "test">("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    void refresh();
  }, [configured, refresh]);
  useEffect(() => setNow(Date.now()), [state]);
  const followed = useRef<SyncPreferences | null>(null);
  useEffect(() => {
    if (!state) return;
    const saved = { mode: state.mode, syncLists: state.syncLists };
    const follow = savedPreferencesToFollow(followed.current, saved);
    followed.current = saved;
    if (!follow) return;
    setMode(follow.mode);
    setLists(follow.syncLists);
  }, [state]);
  const savePreferences = async (next: SyncPreferences) => {
    setMode(next.mode);
    setLists(next.syncLists);
    try {
      await api("/hardcover/config", { method: "PATCH", body: JSON.stringify(next) });
      hardcoverChanged();
    } catch (error) {
      notify((error as Error).message, true);
      // Not saved: show the saved preferences again.
      if (followed.current) {
        setMode(followed.current.mode);
        setLists(followed.current.syncLists);
      }
    }
  };
  const saveToken = async (hardcover: string) => {
    try {
      await patchSettings({ hardcover });
      onSaved();
      hardcoverChanged();
      notify(hardcover ? "Hardcover token saved." : "Connection removed.");
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const run = async (action: "sync" | "test") => {
    setBusy(action);
    try {
      if (action === "test") {
        const account = await api<{ username: string | null }>("/hardcover/test", { method: "POST" });
        notify(account.username ? `Connected to @${account.username}.` : "Hardcover account connected.");
      } else {
        const result = await api<{ imported: number; matched: number; progress: number; pending: number }>("/hardcover/sync", { method: "POST" });
        notify(
          `Synced ${result.imported} new books, ${result.matched} matches, and ${result.progress} reading positions.${result.pending ? ` ${result.pending} changes remain queued.` : ""}`,
        );
      }
      hardcoverChanged();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy("");
      await refresh();
    }
  };
  const ready = configured && !!state;
  return (
    <>
      <Group caption="Hardcover" note={ready ? (state.lastError ?? state.listWarning ?? undefined) : undefined} noteFailed={!!(ready && state.lastError)}>
        <Row label="Status" value={configured ? "Connected" : "Not connected"} />
        <FieldRow label="API token" name="Hardcover API token" type="password" secret isSet={configured} onSave={saveToken} />
        {ready && (
          <>
            <ChoiceRow
              name="Sync mode"
              options={SYNC_MODES}
              value={mode}
              onChange={(next) => void savePreferences({ mode: next, syncLists: lists })}
            />
            <Row label="Include my lists" control={<Switch label="Include my lists" on={lists} onChange={(on) => void savePreferences({ mode, syncLists: on })} />} />
            <Row
              label="Sync"
              value={hardcoverSyncLine(state, now)}
              control={
                <Button kind="secondary" disabled={!!busy || state.mode === "off"} onClick={() => void run("sync")}>
                  {busy === "sync" ? "Syncing…" : "Sync now"}
                </Button>
              }
            />
          </>
        )}
        {configured && (
          <ActionsRow>
            <Button kind="secondary" aria-label="Test Hardcover" disabled={!!busy} onClick={() => void run("test")}>
              {busy === "test" ? "Testing…" : "Test"}
            </Button>
            <Button kind="quiet" className="settings-failed-action" aria-label="Disconnect Hardcover" onClick={() => void saveToken("")}>
              Disconnect
            </Button>
          </ActionsRow>
        )}
      </Group>
    </>
  );
}

/** The accounts, the account requests and Add user (the administrator's). */
export function UsersPage({ user, notify, onChanged }: { user: Account; notify: Notify; onChanged: () => void }) {
  const [users, setUsers] = useState<Account[]>([]);
  const [requests, setRequests] = useState<AccountRequest[] | null>(null);
  const [chosen, setChosen] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<number | null>(null);
  const [approval, setApproval] = useState<{ username: string; link: string; delivered: boolean } | null>(null);
  const refresh = () =>
    api<Account[]>("/users")
      .then((list) => {
        setUsers(list);
        onChanged();
      })
      .catch((error: Error) => notify(error.message, true));
  const refreshRequests = () =>
    api<AccountRequest[]>("/account-requests")
      .then(setRequests)
      .catch((error: Error) => notify(error.message, true));
  useEffect(() => {
    void refresh();
    void refreshRequests();
  }, [user.id]);
  const review = async (request: AccountRequest, decision: "approve" | "decline") => {
    setActing(request.id);
    try {
      if (decision === "decline") {
        await api(`/account-requests/${request.id}/decline`, { method: "POST" });
        setApproval(null);
        notify(`Declined ${request.username}.`);
      } else {
        const result = await api<{ ok: boolean; inviteLink: string; emailDelivered: boolean }>(`/account-requests/${request.id}/approve`, { method: "POST" });
        setApproval({ username: request.username, link: result.inviteLink, delivered: result.emailDelivered });
        await refresh();
      }
      await refreshRequests();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setActing(null);
    }
  };
  const copyLink = async () => {
    if (!approval) return;
    try {
      await navigator.clipboard.writeText(approval.link);
      notify("Invite link copied.");
    } catch (error) {
      notify(error instanceof Error && error.message ? `Could not copy the link. ${error.message}` : "Could not copy the link.", true);
    }
  };
  const now = Date.now();
  return (
    <>
      <Group caption={users.length ? `Accounts · ${users.length}` : "Accounts"}>
        {users.map((account) =>
          account.role === "admin" ? (
            <Row key={account.id} label={account.username} value="Administrator" />
          ) : (
            <Row key={account.id} label={account.username} value="User" opens onClick={() => setChosen(account)} />
          ),
        )}
      </Group>
      <div className="part-group-block settings-requests-block">
        <h2 className="part-group-caption type-caption" id="settings-requests-caption">
          {requests?.length ? `Account requests · ${requests.length}` : "Account requests"}
        </h2>
        {requests && requests.length === 0 && <p className="settings-requests-empty type-body">{NO_REQUESTS}</p>}
        {!!requests?.length && (
          <ul className="settings-requests" role="list" aria-labelledby="settings-requests-caption">
            {requests.map((request) => (
              <li key={request.id} className="settings-request" aria-label={request.username}>
                <div className="settings-request-text">
                  <div className="settings-request-head">
                    <span className="type-body settings-request-name">{request.username}</span>
                    <span className="type-caption settings-muted">{requestAge(request.createdAt, now)}</span>
                  </div>
                  <span className="type-label settings-muted">{request.email}</span>
                  {request.note && <span className="type-label">{request.note}</span>}
                </div>
                <div className="settings-request-actions">
                  <Button kind="secondary" disabled={acting !== null} onClick={() => void review(request, "decline")}>
                    Decline
                  </Button>
                  <Button kind="primary" disabled={acting !== null} onClick={() => void review(request, "approve")}>
                    Approve
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {approval && (
          <div className="settings-approval" role="status">
            <p className="type-label">{approvedLine(approval.username, approval.delivered)}</p>
            <code className="settings-approval-link type-caption">{approval.link}</code>
            <Button kind="secondary" onClick={() => void copyLink()}>
              Copy link
            </Button>
          </div>
        )}
        <p className="part-group-note">{APPROVING_NOTE}</p>
      </div>
      <Button kind="secondary" className="settings-wide-button" icon={<PlusIcon />} onClick={() => setAdding(true)}>
        Add user
      </Button>
      <AccountDialog
        account={chosen}
        onClose={() => setChosen(null)}
        notify={notify}
        onDone={() => {
          setChosen(null);
          void refresh();
        }}
      />
      <AddUserDialog
        open={adding}
        onClose={() => setAdding(false)}
        notify={notify}
        onAdded={() => {
          setAdding(false);
          void refresh();
        }}
      />
    </>
  );
}

/** The small dialog of an account: Reset password and Remove user, each asking once. */
function AccountDialog({ account, onClose, onDone, notify }: { account: Account | null; onClose: () => void; onDone: () => void; notify: Notify }) {
  const [step, setStep] = useState<"choose" | "reset" | "remove">("choose");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // The last account shown, so the dialog keeps its words while it closes.
  const shown = useRef<Account | null>(null);
  if (account) shown.current = account;
  useEffect(() => {
    if (!account) return;
    setStep("choose");
    setPassword("");
  }, [account]);
  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await run();
      notify(done);
      onDone();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const name = shown.current?.username ?? "";
  return (
    <Dialog
      open={!!account}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={step === "remove" ? `Remove ${name}?` : step === "reset" ? `Reset password for ${name}` : name}
      className="settings-dialog"
    >
      {step === "choose" && (
        <div className="settings-dialog-actions settings-dialog-column">
          <Button kind="secondary" onClick={() => setStep("reset")}>
            Reset password
          </Button>
          <Button kind="secondary" className="settings-failed-action" onClick={() => setStep("remove")}>
            Remove user
          </Button>
        </div>
      )}
      {step === "reset" && (
        <form
          className="settings-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            const id = account!.id;
            void act(() => api(`/users/${id}`, { method: "PATCH", body: JSON.stringify({ password }) }), "Password reset.");
          }}
        >
          <label className="settings-dialog-field">
            <span className="type-body">New password</span>
            <input type="password" autoComplete="new-password" required autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <div className="settings-dialog-actions">
            <Button kind="secondary" onClick={() => setStep("choose")}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" disabled={busy}>
              Reset password
            </Button>
          </div>
        </form>
      )}
      {step === "remove" && (
        <div className="settings-dialog-actions">
          <Button kind="secondary" onClick={() => setStep("choose")}>
            Cancel
          </Button>
          <Button
            kind="primary"
            className="settings-danger-primary"
            disabled={busy}
            onClick={() => {
              const id = account!.id;
              void act(() => api(`/users/${id}`, { method: "DELETE" }), `Removed ${name}.`);
            }}
          >
            Remove user
          </Button>
        </div>
      )}
    </Dialog>
  );
}

/** Add user: Username and Password in a dialog; the new account is a User. */
function AddUserDialog({ open, onClose, onAdded, notify }: { open: boolean; onClose: () => void; onAdded: () => void; notify: Notify }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setUsername("");
    setPassword("");
  }, [open]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/users", { method: "POST", body: JSON.stringify({ username, password, role: "user" }) });
      notify(`Added ${username}.`);
      onAdded();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Add user"
      className="settings-dialog"
    >
      <form className="settings-dialog-form" onSubmit={(event) => void submit(event)}>
        <label className="settings-dialog-field">
          <span className="type-body">Username</span>
          <input required autoComplete="off" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="settings-dialog-field">
          <span className="type-body">Password</span>
          <input type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <div className="settings-dialog-actions">
          <Button kind="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" disabled={busy}>
            Add user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Library name with its Save, the media drive with its tooltip, and Used with its bar (the administrator's). */
export function LibraryStoragePage({ settings, onSaved, notify }: Omit<Props, "user">) {
  const saveName = async (name: string) => {
    try {
      await patchSettings({ name });
      onSaved();
      notify("Saved.");
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const storage = settings?.storage ?? null;
  const used = storage && usedLine(storage);
  return (
    <>
      <Group caption="Library">
        <FieldRow label="Library name" name="Library name" required maxLength={60} saved={settings?.name ?? ""} onSave={saveName} />
      </Group>
      {storage && (
        <Group caption="Server storage">
          <Row
            label="Media drive"
            info={<InfoMark name="Media drive" text={tip("mediaDrive")} />}
            value={storage.connected ? MEDIA_DRIVE_CONNECTED : MEDIA_DRIVE_NOT_CONNECTED}
            failed={!storage.connected}
          />
          {used && <Row label="Used" value={used} progress={usedShare(storage)} />}
        </Group>
      )}
    </>
  );
}
