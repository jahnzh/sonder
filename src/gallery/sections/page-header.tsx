// Page header (spec #480, "Parts"). The gallery's own header is the one without a back button (one Title per
// page); the child page shows the one with it.
import { navigate } from "../../navigation";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

export default {
  id: "page-header",
  title: "Page header",
  order: 40,
  render: () => (
    <Sample id="page-header-child" state="With a back button">
      <Group label="Child page">
        <Row label="Child page" opens onClick={() => navigate({ name: "gallery-child" })} />
      </Group>
    </Sample>
  ),
} satisfies GallerySection;
