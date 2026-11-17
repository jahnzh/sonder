// Sheet (spec #480, "Parts"; #492): the gallery's own sheet at `#gallery/sheet`, since no real sheet exists before
// Get. It opens over the gallery with an entry of its own; Back, Close or Escape closes it.
import { navigate, useAddress } from "../../navigation";
import { Button } from "../../parts/Button";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import { Sheet } from "../../parts/Sheet";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

const choices = ["Recording 1", "Recording 2", "Recording 3", "Recording 4", "Recording 5", "Recording 6", "Recording 7", "Recording 8"];

function GallerySheet() {
  const { goBack } = useAddress();
  return (
    <Sheet
      title="Sheet"
      footer={
        <Button kind="primary" onClick={() => goBack()}>
          Done
        </Button>
      }
    >
      <h1 className="type-heading" style={{ margin: 0 }}>
        Gallery sheet
      </h1>
      <Group caption="Choices">
        {choices.map((choice) => (
          <Row key={choice} label={choice} value="MP3" />
        ))}
      </Group>
    </Sheet>
  );
}

function SheetSample() {
  const { route } = useAddress();
  return (
    <Sample id="sheet-open" state="Opens over the page">
      <Group label="Sheet">
        <Row label="Sheet" opens onClick={() => navigate({ name: "gallery-sheet" })} />
      </Group>
      {route.name === "gallery-sheet" && <GallerySheet />}
    </Sample>
  );
}

export default {
  id: "sheet",
  title: "Sheet",
  order: 90,
  render: () => <SheetSample />,
} satisfies GallerySection;
