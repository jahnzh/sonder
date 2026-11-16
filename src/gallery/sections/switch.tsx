// Switch (spec #480, "Parts"; boards Main.dc.html and SettingsPlayback.dc.html): on and off, each also disabled,
// in a Row as the boards show it.
import { useState } from "react";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import { Switch } from "../../parts/Switch";
import type { GallerySection, GalleryTools } from "../section";
import { Sample } from "../Sample";

function SwitchRow({ label, initial, disabled, act }: { label: string; initial: boolean; disabled?: boolean; act: GalleryTools["act"] }) {
  const [on, setOn] = useState(initial);
  return (
    <Row
      label={label}
      control={
        <Switch
          label={label}
          on={on}
          disabled={disabled}
          onChange={(next) => {
            setOn(next);
            act(`${label} ${next ? "on" : "off"}`);
          }}
        />
      }
    />
  );
}

export default {
  id: "switch",
  title: "Switch",
  order: 70,
  render: ({ act }) => (
    <>
      <Sample id="switch-on" state="On">
        <Group label="Switch on">
          <SwitchRow label="Follow the narration" initial act={act} />
        </Group>
      </Sample>
      <Sample id="switch-off" state="Off">
        <Group label="Switch off">
          <SwitchRow label="Keep on this device" initial={false} act={act} />
        </Group>
      </Sample>
      <Sample id="switch-disabled" state="Disabled">
        <Group label="Switch disabled">
          <SwitchRow label="Start new reading sync work" initial disabled act={act} />
          <SwitchRow label="Start new series searches" initial={false} disabled act={act} />
        </Group>
      </Sample>
    </>
  ),
} satisfies GallerySection;
