// Settings › App (board SettingsApp.dc.html): Version, Updates (the update notice's own check), Installed or
// Install, and Reset this device.
import { useState } from "react";
import { DeviceResetRow } from "../../components/DeviceReset";
import { reloadForUpdate, runningBuild, useAvailableUpdate } from "../../app-update";
import { usePlayer } from "../../player";
import { Button } from "../../parts/Button";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";

type Notify = (text: string, error?: boolean) => void;

export const INSTALL_BY_MENU = "Use your browser’s menu to install Sonder.";

/** Whether this tab is the installed app (a home-screen or desktop app window). */
export function runsInstalled(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function AppPage({ installable, onInstall, notify }: { installable: boolean; onInstall: () => void; notify: Notify }) {
  const update = useAvailableUpdate();
  const player = usePlayer();
  const [reloading, setReloading] = useState(false);
  const installed = runsInstalled();
  return (
    <>
      <Group caption="This app" note={!installed && !installable ? INSTALL_BY_MENU : undefined}>
        <Row label="Version" value={runningBuild()} />
        {update ? (
          <Row
            label="Updates"
            value="An update is ready"
            control={
              <Button
                kind="primary"
                disabled={reloading}
                onClick={() => {
                  setReloading(true);
                  void reloadForUpdate(() => {
                    if (player.playing) player.toggle();
                  }).catch(() => setReloading(false));
                }}
              >
                {reloading ? "Reloading…" : "Reload"}
              </Button>
            }
          />
        ) : (
          <Row label="Updates" value="Up to date" />
        )}
        {installed ? (
          <Row label="Installed" value="On this device" />
        ) : installable ? (
          <Row
            label="Installed"
            value="No"
            control={
              <Button kind="secondary" onClick={onInstall}>
                Install
              </Button>
            }
          />
        ) : (
          <Row label="Installed" value="No" />
        )}
      </Group>
      <Group label="Reset">
        <DeviceResetRow notify={notify} />
      </Group>
    </>
  );
}
