// Settings › Playback › Keyboard shortcuts (#614, board SettingsKeys.dc.html): the keys that work, in their groups,
// each row the action on the left and its key on the right. It renders KEYBOARD_SHORTCUTS and nothing else.
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import { shortcutGroups } from "../../keyboard";

export function KeyboardPage() {
  return (
    <>
      {shortcutGroups().map(({ group, rows }) => (
        <Group key={group} caption={group}>
          {rows.map((row) => (
            <Row key={row.action} label={row.action} detail={row.note} control={<kbd className="settings-kbd type-label">{row.key}</kbd>} />
          ))}
        </Group>
      ))}
    </>
  );
}
