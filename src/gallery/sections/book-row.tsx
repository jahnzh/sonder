// Book row (spec #480, "Parts"; #490) in each state: opening a book, moving with its bar, with a number in front
// (the series row, 56 high), with a cover, not in the library, and a long title.
import { BookRow } from "../../parts/BookRow";
import { Group } from "../../parts/Group";
import { NOT_IN_LIBRARY_LINE, downloadLine, readingSyncLine } from "../../status-lines";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

// A cover drawn in the page itself, so the gallery needs no file of the library.
const cover = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 60"><rect width="40" height="60" fill="#5f5230"/><rect x="6" y="10" width="28" height="4" fill="#e0b060"/></svg>')}`;

export default {
  id: "book-row",
  title: "Book row",
  order: 51,
  render: ({ act }) => (
    <>
      <Sample id="book-row-opens" state="Opens a book">
        <Group label="Books">
          <BookRow title="Feral Gods" status="Chapter 3 · 5 h left" marks={["audiobook", "ebook"]} cover={cover} onClick={() => act("Feral Gods pressed")} />
          <BookRow title="The Hydrogen Sonata" status="Audiobook and ebook · 414 MB" onClick={() => act("The Hydrogen Sonata pressed")} />
        </Group>
      </Sample>
      <Sample id="book-row-moving" state="Moving">
        <Group label="Books with work in progress">
          <BookRow
            title="Feral Gods"
            status={`${readingSyncLine({ hasEbook: true, hasRecording: true, job: { status: "processing", wholeBook: true, stage: "encoding" } })} · 24 of 43 files`}
            marks={["sync"]}
            progress={24 / 43}
            onClick={() => act("Moving book pressed")}
          />
        </Group>
      </Sample>
      <Sample id="book-row-numbered" state="With a number (series)">
        <Group label="Series">
          <BookRow number={1} title="Consider Phlebas" status="Finished" marks={["audiobook", "ebook"]} onClick={() => act("Consider Phlebas pressed")} />
          <BookRow number={2} title="The Player of Games" status="Finished" marks={["audiobook", "ebook"]} cover={cover} onClick={() => act("The Player of Games pressed")} />
          <BookRow number="2.5" title="The State of the Art" status={NOT_IN_LIBRARY_LINE} />
          <BookRow number={3} title="Use of Weapons" status={downloadLine({ status: "downloading", progress: 0.43 })!} marks={["audiobook"]} progress={0.43} onClick={() => act("Use of Weapons pressed")} />
        </Group>
      </Sample>
      <Sample id="book-row-plain" state="Shows only">
        <Group label="A book that does not open">
          <BookRow title="Excession" status={NOT_IN_LIBRARY_LINE} />
        </Group>
      </Sample>
      <Sample id="book-row-long" state="A long title">
        <Group label="A long title">
          <BookRow title="The Long Way to a Small, Angry Planet: Wayfarers, Book One" status="Chapter 3 · 5 h left" marks={["audiobook"]} onClick={() => act("Long book row pressed")} />
        </Group>
      </Sample>
    </>
  ),
} satisfies GallerySection;
