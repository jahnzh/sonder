// The library by work on the device (#528): every stored work as `useWork` gives it to a page, with this
// device's newer places laid over. No screen uses the hook yet (the Book page's tickets do); this section lets
// the browser spec and builders see what it returns, also after a reload without a connection.
import { clock } from "../../lib";
import { useStoredWorks, useWork } from "../../library-works-store";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

function StoredWork({ workId }: { workId: string }) {
  const { work, status } = useWork(workId);
  if (!work) return <p className="type-caption">{status}</p>;
  return (
    <Group label={work.title}>
      {work.recordings.map((recording, index) => {
        const place = recording.progress;
        const track = place ? recording.tracks.findIndex((entry) => entry.id === place.trackId) : -1;
        return (
          <Row
            key={recording.recordingId}
            label={`Recording ${index + 1}`}
            value={place ? `Track ${track + 1} · ${clock(place.position)}` : "No place"}
          />
        );
      })}
      {work.ebooks.map((ebook) => (
        <Row
          key={ebook.id}
          label={`Ebook ${ebook.format.toUpperCase()}`}
          value={ebook.place?.progression != null ? `${Math.round(ebook.place.progression * 100)}%` : "No place"}
        />
      ))}
    </Group>
  );
}

function StoredWorks() {
  const works = useStoredWorks();
  return (
    <Sample id="works-stored" state="Stored on this device">
      {works.length ? works.map((work) => <StoredWork key={work.workId} workId={work.workId} />) : <p className="type-caption">None</p>}
    </Sample>
  );
}

export default {
  id: "works",
  title: "Works on this device",
  order: 900,
  render: () => <StoredWorks />,
} satisfies GallerySection;
