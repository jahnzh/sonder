// Chip (spec #480, "Parts"; board Library.dc.html): selected, not selected, disabled, and a row of filter chips
// where one is chosen at a time.
import { useState } from "react";
import { Chip } from "../../parts/Chip";
import type { GallerySection, GalleryTools } from "../section";
import { Sample } from "../Sample";

function Toggle({ text, initial, act }: { text: string; initial: boolean; act: GalleryTools["act"] }) {
  const [selected, setSelected] = useState(initial);
  return (
    <Chip
      selected={selected}
      onClick={() => {
        setSelected(!selected);
        act(`${text} ${selected ? "not selected" : "selected"}`);
      }}
    >
      {text}
    </Chip>
  );
}

const filters = ["All", "In progress", "Finished", "Favorites"] as const;
function Filters({ act }: GalleryTools) {
  const [chosen, setChosen] = useState<string>("All");
  return (
    <div className="gallery-row-of-buttons" role="group" aria-label="Filter your library">
      {filters.map((filter) => (
        <Chip
          key={filter}
          selected={chosen === filter}
          onClick={() => {
            setChosen(filter);
            act(`${filter} selected`);
          }}
        >
          {filter}
        </Chip>
      ))}
    </div>
  );
}

export default {
  id: "chip",
  title: "Chip",
  order: 50,
  render: ({ act }) => (
    <>
      <Sample id="chip-selected" state="Selected">
        <div className="gallery-row-of-buttons">
          <Toggle text="Series" initial act={act} />
        </div>
      </Sample>
      <Sample id="chip-not-selected" state="Not selected">
        <div className="gallery-row-of-buttons">
          <Toggle text="On device" initial={false} act={act} />
        </div>
      </Sample>
      <Sample id="chip-disabled" state="Disabled">
        <div className="gallery-row-of-buttons">
          <Chip selected disabled>
            Not started
          </Chip>
          <Chip selected={false} disabled>
            Shelf
          </Chip>
        </div>
      </Sample>
      <Sample id="chip-filters" state="One of a row">
        <Filters act={act} />
      </Sample>
    </>
  ),
} satisfies GallerySection;
