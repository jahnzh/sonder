import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionsValue, settingsList, storageValue, themeName, type SettingsListInput } from "../src/settings-list.ts";

const base: SettingsListInput = {
  user: { username: "jahn", role: "admin" },
  settings: { torboxConfigured: true, hardcoverConfigured: true, prowlarrConfigured: false },
  appearance: { preset: "forest", colors: {} },
  speed: 1.2,
  accounts: 3,
  installed: true,
};
const rows = (input: SettingsListInput) =>
  settingsList(input).map((group) => [group.caption, group.rows.map((row) => `${row.page}|${row.label}|${row.value}`)]);

test("the administrator's list: Personal, Server and This device, each row with its value (board Settings.dc.html)", () => {
  assert.deepEqual(rows(base), [
    ["Personal", ["account|Account|jahn · Admin", "appearance|Appearance|Forest", "playback|Playback|1.2×"]],
    ["Server", ["connections|Connections|TorBox, Hardcover", "users|Users|3 accounts", "library|Library and storage|"]],
    ["This device", ["app|App|Installed"]],
  ]);
});

test("someone who is not the administrator: Connections in Personal, no Server group, only Hardcover counted", () => {
  const list = rows({ ...base, user: { username: "reader", role: "user" }, accounts: null, installed: false });
  assert.deepEqual(list, [
    [
      "Personal",
      ["account|Account|reader · User", "appearance|Appearance|Forest", "playback|Playback|1.2×", "connections|Connections|Hardcover"],
    ],
    ["This device", ["app|App|Install"]],
  ]);
  // The administrator's TorBox is not named to someone else.
  assert.equal(connectionsValue({ torboxConfigured: true, hardcoverConfigured: false }, false), "Not connected");
});

test("row values: theme with custom colours, one account, nothing connected, the drive's free space", () => {
  assert.equal(themeName({ preset: "charcoal", colors: {} }), "Charcoal");
  assert.equal(themeName({ preset: "forest", colors: { text: "#ffffff" } }), "Custom colours");
  assert.equal(rows({ ...base, accounts: 1 })[1][1][1], "users|Users|1 account");
  assert.equal(rows({ ...base, accounts: null })[1][1][1], "users|Users|");
  assert.equal(connectionsValue(null, true), "");
  assert.equal(connectionsValue({ torboxConfigured: false, hardcoverConfigured: false, prowlarrConfigured: true }, true), "Prowlarr");
  assert.equal(storageValue({ ...base.settings!, storage: { connected: true, usedBytes: 1e12, totalBytes: 4e12 } }), "3 TB free");
  assert.equal(storageValue({ ...base.settings!, storage: { connected: false, usedBytes: null, totalBytes: null } }), "Not connected");
  assert.equal(storageValue({ ...base.settings!, storage: null }), "");
  assert.equal(storageValue(base.settings), "");
});
