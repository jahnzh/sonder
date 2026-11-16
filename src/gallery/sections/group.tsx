// Group (spec #480, "Parts"): with a caption and a note, without a caption, with one row.
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

export default {
  id: "group",
  title: "Group",
  order: 20,
  render: ({ act }) => (
    <>
      <Sample id="group-caption" state="With a caption and a note">
        <Group caption="Playback" note="Applies to every book.">
          <Row label="Default speed" value="1.2×" opens onClick={() => act("Default speed pressed")} />
          <Row label="Skip back" value="30 s" opens onClick={() => act("Skip back pressed")} />
          <Row label="Plays from" value="Server copy" />
        </Group>
      </Sample>
      <Sample id="group-plain" state="Without a caption">
        <Group label="Account">
          <Row label="Username" value="admin" />
          <Row label="Sign out" onClick={() => act("Sign out pressed")} />
        </Group>
      </Sample>
      <Sample id="group-one" state="One row">
        <Group label="One row">
          <Row label="Version" value="1.0" />
        </Group>
      </Sample>
    </>
  ),
} satisfies GallerySection;
