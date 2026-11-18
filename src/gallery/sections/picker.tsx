// Picker (spec #572, "The Picker part"; boards LibrarySort.dc.html, LibraryShelf.dc.html): the one-list picker whose
// choice closes it, and the full picker with choice rows, a Segmented control and picker rows that open a second
// list inside it. Each opens from its own button: from the bottom edge on a phone, under the button on a desktop.
import { useRef, useState } from "react";
import { Button } from "../../parts/Button";
import { Picker, PickerChoices, PickerDialog, PickerGroup, PickerRow, PickerRows } from "../../parts/Picker";
import { Segmented } from "../../parts/Segmented";
import type { GallerySection, GalleryTools } from "../section";
import { Sample } from "../Sample";

const sorts = [
  { value: "recent", label: "Recently added" },
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "progress", label: "Progress" },
] as const;
type Sort = (typeof sorts)[number]["value"];
const shelves = [
  { value: "all", label: "All shelves" },
  { value: "1", label: "Want to read" },
  { value: "2", label: "Currently reading" },
  { value: "3", label: "Read" },
  { value: "4", label: "Paused" },
  { value: "5", label: "Did not finish" },
];
const lists = [
  { value: "all", label: "All lists" },
  { value: "10", label: "Weekend escapes", detail: "3" },
  { value: "11", label: "A list whose name is far too long for one line of the picker", detail: "12" },
];

function OneList({ act }: { act: GalleryTools["act"] }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("1");
  return (
    <>
      <Button onClick={() => setOpen(true)}>Shelf: {shelves.find((s) => s.value === value)!.label}</Button>
      <Picker
        open={open}
        title="Shelf"
        options={shelves.slice(1)}
        value={value}
        onClose={() => setOpen(false)}
        onChoose={(next) => {
          setValue(next);
          act(`Shelf: ${shelves.find((s) => s.value === next)!.label}`);
        }}
      />
    </>
  );
}

function Full({ act }: { act: GalleryTools["act"] }) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<Sort>("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [shelf, setShelf] = useState("all");
  const [list, setList] = useState("all");
  const [second, setSecond] = useState<"Shelf" | "List" | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setSecond(null);
  };
  const sub =
    second === "Shelf"
      ? {
          title: "Shelf",
          onBack: () => setSecond(null),
          content: (
            <PickerChoices
              label="Shelf"
              options={shelves}
              value={shelf}
              onChoose={(next) => {
                setShelf(next);
                setSecond(null);
                act(`Shelf: ${shelves.find((s) => s.value === next)!.label}`);
              }}
            />
          ),
        }
      : second === "List"
        ? {
            title: "List",
            onBack: () => setSecond(null),
            content: (
              <PickerChoices
                label="List"
                options={lists}
                value={list}
                onChoose={(next) => {
                  setList(next);
                  setSecond(null);
                  act(`List: ${lists.find((l) => l.value === next)!.label}`);
                }}
              />
            ),
          }
        : null;
  return (
    <>
      <button ref={button} type="button" className="part-button type-label" data-kind="quiet" onClick={() => setOpen(true)}>
        Sort and view
      </button>
      <PickerDialog open={open} title="Sort and view" onClose={close} anchor={button} sub={sub}>
        <PickerGroup caption="Sort">
          <PickerChoices
            label="Sort"
            options={sorts}
            value={sort}
            onChoose={(next) => {
              setSort(next);
              act(`Sort: ${sorts.find((s) => s.value === next)!.label}`);
            }}
          />
        </PickerGroup>
        <PickerGroup caption="View">
          <Segmented
            label="View"
            options={[
              { value: "grid", label: "Grid" },
              { value: "list", label: "List" },
            ]}
            value={view}
            onChange={(next) => {
              setView(next);
              act(`View: ${next === "grid" ? "Grid" : "List"}`);
            }}
          />
        </PickerGroup>
        <PickerGroup caption="Hardcover">
          <PickerRows>
            <PickerRow label="Shelf" value={shelves.find((s) => s.value === shelf)!.label} onOpen={() => setSecond("Shelf")} />
            <PickerRow label="List" value={lists.find((l) => l.value === list)!.label} onOpen={() => setSecond("List")} />
          </PickerRows>
        </PickerGroup>
      </PickerDialog>
    </>
  );
}

export default {
  id: "picker",
  title: "Picker",
  order: 95,
  render: ({ act }) => (
    <>
      <Sample id="picker-one-list" state="One list: a choice closes it">
        <OneList act={act} />
      </Sample>
      <Sample id="picker-full" state="Choice rows, a Segmented control and picker rows with their second list">
        <Full act={act} />
      </Sample>
    </>
  ),
} satisfies GallerySection;
