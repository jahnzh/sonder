// Choice row (spec #480, "Parts"; #490): a group with one row chosen, and a group with none chosen yet.
import { useState } from "react";
import { ChoiceGroup, type Choice } from "../../parts/ChoiceRow";
import type { GallerySection, GalleryTools } from "../section";
import { Sample } from "../Sample";

const recordings: Choice<string>[] = [
  { value: "first", label: "Narrator One", detail: "English · 9 h 12 min · M4B" },
  { value: "second", label: "Narrator Two", detail: "English · 9 h 40 min · MP3" },
  { value: "third", label: "Narrator Three", detail: "German · 10 h 5 min · MP3" },
];
const formats: Choice<string>[] = [
  { value: "epub", label: "EPUB", detail: "1.2 MB · Standard Ebooks" },
  { value: "pdf", label: "PDF", detail: "4.8 MB · Anna's Archive" },
];

function Chooser({ id, state, label, options, initial, act }: { id: string; state: string; label: string; options: Choice<string>[]; initial: string | null } & GalleryTools) {
  const [value, setValue] = useState(initial);
  return (
    <Sample id={id} state={state}>
      <ChoiceGroup
        label={label}
        options={options}
        value={value}
        onChange={(next) => {
          setValue(next);
          act(`${options.find((option) => option.value === next)!.label} chosen`);
        }}
      />
    </Sample>
  );
}

export default {
  id: "choice-row",
  title: "Choice row",
  order: 52,
  render: ({ act }) => (
    <>
      <Chooser id="choice-row-chosen" state="One chosen" label="Recordings" options={recordings} initial="first" act={act} />
      <Chooser id="choice-row-none" state="None chosen" label="Editions" options={formats} initial={null} act={act} />
    </>
  ),
} satisfies GallerySection;
