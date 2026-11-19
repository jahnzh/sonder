// Settings (spec #572 "Settings"; boards Settings.dc.html, DesktopSettings.dc.html): a list whose rows open pages.
// On a phone `#settings` is the list and `#settings/<page>` a Page with "Back to Settings"; on a desktop the list
// stays on the left with the chosen page beside it (Account at `#settings`), and choosing another row replaces the
// history entry.
import { useEffect, useState } from "react";
import { useSideBySide } from "./side-by-side";
import type { Account } from "../components/SignIn";
import { useAppearance } from "../components/Appearance";
import { api } from "../lib";
import { useAddress } from "../navigation";
import { Group } from "../parts/Group";
import { PageHeader } from "../parts/PageHeader";
import { Row } from "../parts/Row";
import { isSettingsPage, parentOf, type SettingsPage as PageName } from "../routes";
import { PAGE_TITLES, settingsList } from "../settings-list";
import type { Settings as SettingsData } from "../types";
import { AccountPage } from "./settings/account";
import { AppPage, runsInstalled } from "./settings/app";
import { AppearancePage } from "./settings/appearance";
import { KeyboardPage } from "./settings/keyboard";
import { PlaybackPage, useDefaultSpeed } from "./settings/playback";
import { ConnectionsPage, LibraryStoragePage, UsersPage } from "./settings/server";
import "./settings/settings.css";

export { SIDE_BY_SIDE } from "./side-by-side";

type Props = {
  user: Account;
  settings: SettingsData | null;
  onSaved: () => void;
  notify: (text: string, error?: boolean) => void;
  needsPassword: boolean;
  onLogout: () => void;
  installPrompt: Event | null;
  onInstall: () => void;
};

export function SettingsPage(props: Props) {
  const { user, settings, notify } = props;
  const admin = user.role === "admin";
  const address = useAddress();
  const sideBySide = useSideBySide();
  const { appearance } = useAppearance();
  const speed = useDefaultSpeed();
  const [accounts, setAccounts] = useState<number | null>(null);
  const countAccounts = () => {
    if (!admin) return;
    void api<unknown[]>("/users")
      .then((list) => setAccounts(list.length))
      .catch(() => {});
  };
  useEffect(countAccounts, [admin, user.id]);
  const route = address.route;
  const asked = route.name === "settings-page" && isSettingsPage(route.page) ? route.page : null;
  // The address resolves an administrator's page for someone else to Settings already; on a desktop the page beside
  // the list at `#settings` is Account.
  const shown: PageName | null = asked ?? (sideBySide ? "account" : null);
  // Keyboard shortcuts is Playback's page (#614): beside the list, Playback is the row chosen.
  const chosen: PageName | null = shown === "keyboard" ? "playback" : shown;
  const open = (page: PageName) => {
    if (page === shown) return;
    address.navigate({ name: "settings-page", page }, { replace: sideBySide });
  };
  const groups = settingsList({ user, settings, appearance, speed, accounts, installed: runsInstalled() });
  const list = (
    <nav className="settings-list" aria-label="Settings">
      {groups.map((group) => (
        <Group key={group.caption} caption={group.caption}>
          {group.rows.map((row) => (
            <Row
              key={row.page}
              label={row.label}
              value={row.value}
              opens
              current={sideBySide && row.page === chosen}
              onClick={() => open(row.page)}
            />
          ))}
        </Group>
      ))}
    </nav>
  );
  const page = shown && (
    <PageBody
      page={shown}
      {...props}
      onUsersChanged={countAccounts}
    />
  );
  if (sideBySide)
    return (
      <div className="settings-split">
        <div className="settings-split-list">
          <PageHeader title="Settings" />
          {list}
        </div>
        {page && (
          <section className="settings-split-page" aria-labelledby="settings-page-title" data-page={shown}>
            {shown === "keyboard" ? (
              <PageHeader title={PAGE_TITLES.keyboard} back parent={parentOf(route) ?? undefined} level={2} titleId="settings-page-title" />
            ) : (
              <h2 id="settings-page-title" className="type-title settings-page-title">
                {PAGE_TITLES[shown!]}
              </h2>
            )}
            <div className="settings-page-body">{page}</div>
          </section>
        )}
      </div>
    );
  if (!shown)
    return (
      <div className="settings-phone">
        <PageHeader title="Settings" />
        {list}
      </div>
    );
  return (
    <div className="settings-phone" data-page={shown}>
      <PageHeader title={PAGE_TITLES[shown]} back parent={parentOf(route) ?? { name: "settings" }} />
      <div className="settings-page-body">{page}</div>
    </div>
  );
}

function PageBody({ page, onUsersChanged, ...props }: Props & { page: PageName; onUsersChanged: () => void }) {
  switch (page) {
    case "account":
      return <AccountPage user={props.user} needsPassword={props.needsPassword} onLogout={props.onLogout} notify={props.notify} />;
    case "appearance":
      return <AppearancePage notify={props.notify} />;
    case "playback":
      return <PlaybackPage notify={props.notify} />;
    case "connections":
      return <ConnectionsPage user={props.user} settings={props.settings} onSaved={props.onSaved} notify={props.notify} />;
    case "users":
      return <UsersPage user={props.user} notify={props.notify} onChanged={onUsersChanged} />;
    case "library":
      return <LibraryStoragePage settings={props.settings} onSaved={props.onSaved} notify={props.notify} />;
    case "app":
      return <AppPage installable={!!props.installPrompt} onInstall={props.onInstall} notify={props.notify} />;
    case "keyboard":
      return <KeyboardPage />;
  }
}
