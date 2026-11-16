// File row (spec #480, "Parts"; #490) in each state: its three icons; opening a page; moving, with its bar; with a
// button (Get); moving and with a button; a long status line. Status lines come from src/status-lines.ts.
import { Button } from "../../parts/Button";
import { FileRow } from "../../parts/FileRow";
import { Group } from "../../parts/Group";
import { downloadLine, ebookCheckLine, readingSyncLine } from "../../status-lines";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

export default {
  id: "file-row",
  title: "File row",
  order: 50,
  render: ({ act }) => (
    <>
      <Sample id="file-row-opens" state="Opens a page">
        <Group label="Files">
          <FileRow kind="audiobook" name="Audiobook" status={`Narrator Name · 9 h 12 min · ${downloadLine({ status: "ready", backend: "local" })}`} onClick={() => act("Audiobook pressed")} />
          <FileRow kind="ebook" name="Ebook" status={ebookCheckLine({ status: "accepted" })!} onClick={() => act("Ebook pressed")} />
          <FileRow kind="sync" name="Reading sync" status={readingSyncLine({ hasEbook: true, hasRecording: true, job: { status: "ready" } })!} onClick={() => act("Reading sync pressed")} />
        </Group>
      </Sample>
      <Sample id="file-row-moving" state="Moving">
        <Group label="Moving files">
          <FileRow kind="audiobook" name="Audiobook" status={downloadLine({ status: "downloading", progress: 0.43 })!} progress={0.43} onClick={() => act("Moving audiobook pressed")} />
          <FileRow
            kind="sync"
            name="Reading sync"
            status={`${readingSyncLine({ hasEbook: true, hasRecording: true, job: { status: "processing", wholeBook: true, stage: "encoding" } })} · 24 of 43 files`}
            progress={24 / 43}
            onClick={() => act("Moving reading sync pressed")}
          />
        </Group>
      </Sample>
      <Sample id="file-row-action" state="With a button">
        <Group label="Files to get">
          <FileRow kind="audiobook" name="Audiobook" status={downloadLine({ status: null })!} action={<Button aria-label="Get an audiobook" onClick={() => act("Get an audiobook pressed")}>Get</Button>} />
          <FileRow kind="ebook" name="Ebook" status={ebookCheckLine({ status: "rejected" })!} action={<Button aria-label="Get another ebook" onClick={() => act("Get another ebook pressed")}>Get</Button>} />
        </Group>
      </Sample>
      <Sample id="file-row-moving-action" state="Moving, with a button">
        <Group label="Moving file with a button">
          <FileRow kind="ebook" name="Ebook" status={downloadLine({ status: "paused", progress: 0.61 })!} progress={0.61} action={<Button aria-label="Get the ebook again" onClick={() => act("Get the ebook again pressed")}>Get</Button>} />
        </Group>
      </Sample>
      <Sample id="file-row-long" state="A long status line">
        <Group label="A long status line">
          <FileRow kind="audiobook" name="Audiobook" status="A narrator with a long name · Unabridged · 31 h 48 min · On server" onClick={() => act("Long file row pressed")} />
        </Group>
      </Sample>
    </>
  ),
} satisfies GallerySection;
