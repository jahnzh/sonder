// Segmented control (spec #480, "Parts"; board SettingsPlayback.dc.html): the first or the last segment chosen,
// three segments, and disabled.
import { useState } from "react";
import { Segmented, type SegmentOption } from "../../parts/Segmented";
import type { GallerySection, GalleryTools } from "../section";
import { Sample } from "../Sample";

function Control<T extends string>({ label, options, initial, disabled, act }: { label: string; options: SegmentOption<T>[]; initial: T; disabled?: boolean; act: GalleryTools["act"] }) {
  const [value, setValue] = useState<T>(initial);
  return (
    <Segmented
      label={label}
      options={options}
      value={value}
      disabled={disabled}
      onChange={(next) => {
        setValue(next);
        act(`${label}: ${options.find((option) => option.value === next)!.label}`);
      }}
    />
  );
}

const mode: SegmentOption<"pages" | "scroll">[] = [
  { value: "pages", label: "Pages" },
  { value: "scroll", label: "Scroll" },
];
const progress: SegmentOption<"book" | "chapter">[] = [
  { value: "book", label: "Whole audiobook" },
  { value: "chapter", label: "Current chapter" },
];
const activity: SegmentOption<"now" | "device" | "server">[] = [
  { value: "now", label: "Now" },
  { value: "device", label: "This device" },
  { value: "server", label: "Server" },
];

export default {
  id: "segmented",
  title: "Segmented control",
  order: 60,
  render: ({ act }) => (
    <>
      <Sample id="segmented-first" state="The first chosen">
        <Control label="Reading mode" options={mode} initial="pages" act={act} />
      </Sample>
      <Sample id="segmented-last" state="The last chosen">
        <Control label="Progress bar shows" options={progress} initial="chapter" act={act} />
      </Sample>
      <Sample id="segmented-three" state="Three segments">
        <Control label="Activity" options={activity} initial="device" act={act} />
      </Sample>
      <Sample id="segmented-disabled" state="Disabled">
        <Control label="Reading mode (disabled)" options={mode} initial="scroll" disabled act={act} />
      </Sample>
    </>
  ),
} satisfies GallerySection;
