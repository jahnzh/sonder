// Row (spec #480, "Parts") in each state: with a value, opening a page, with a control, disabled, a long label.
import { Button } from "../../parts/Button";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

export default {
  id: "row",
  title: "Row",
  order: 10,
  render: ({ act }) => (
    <>
      <Sample id="row-value" state="With a value">
        <Group label="With a value">
          <Row label="Plays from" value="Server copy" />
        </Group>
      </Sample>
      <Sample id="row-opens" state="Opens a page">
        <Group label="Opens a page">
          <Row label="Appearance" value="Forest" opens onClick={() => act("Appearance pressed")} />
        </Group>
      </Sample>
      <Sample id="row-action" state="Acts">
        <Group label="Acts">
          <Row label="Mark as finished" onClick={() => act("Mark as finished pressed")} />
        </Group>
      </Sample>
      <Sample id="row-control" state="With a control">
        <Group label="With a control">
          <Row label="Ebook" value="Not added" control={<Button kind="secondary" onClick={() => act("Get pressed")}>Get</Button>} />
        </Group>
      </Sample>
      <Sample id="row-disabled" state="Disabled">
        <Group label="Disabled">
          <Row label="AudiobookDB" value="Not connected" opens disabled onClick={() => act("AudiobookDB pressed")} />
        </Group>
      </Sample>
      <Sample id="row-long" state="A long label">
        <Group label="A long label">
          <Row label="Keep the narration on this device while the screen is off" value="On" opens onClick={() => act("Long row pressed")} />
        </Group>
      </Sample>
    </>
  ),
} satisfies GallerySection;
