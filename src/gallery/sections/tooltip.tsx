// Tooltip (spec #480, "Parts"; #491): an info mark after a row's name, a group caption and a page title, several
// in one group (one open at a time), and an icon without a label that shows its name on hover. Sample texts from
// the board (Tooltips.dc.html); the real texts belong to the slice "One vocabulary". Last on the page, so the marks
// come after every other part in the Tab order.
import type { ReactNode } from "react";
import { Button } from "../../parts/Button";
import { Group } from "../../parts/Group";
import { PageHeader } from "../../parts/PageHeader";
import { Row } from "../../parts/Row";
import { IconName, InfoMark } from "../../parts/Tooltip";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

const texts = {
  protectedStorage:
    "On: the browser keeps these files when the device runs low on space. Off: it may clear them, and the books would have to be saved again.",
  workers:
    "The machines that prepare reading sync and check ebooks against the narration. One with a GPU is used first; one with a CPU is the fallback.",
  readingSync:
    "The ebook follows the narration. It is prepared for one recording and one edition; another recording or edition needs its own.",
  recordings: "Each recording keeps its own place. When you choose another one, Sonder asks where to resume.",
  availableFrom:
    "Where this recording can be played from: a copy on this device, which works offline, a copy on your server, or the stream it was added from.",
  playsFrom:
    "Automatic uses the device copy when there is one, then the server copy, then the original stream. Changing it keeps your place.",
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export default {
  id: "tooltip",
  title: "Tooltip",
  order: 90,
  render: ({ act }) => (
    <>
      <Sample id="tooltip-row" state="After a row's name">
        <Group label="Device">
          <Row label="Protected storage" value="On" info={<InfoMark name="Protected storage" text={texts.protectedStorage} />} />
        </Group>
      </Sample>
      <Sample id="tooltip-caption" state="After a group caption">
        <Group caption="Workers" info={<InfoMark name="Workers" text={texts.workers} />}>
          <Row label="WSL" value="GPU" />
        </Group>
      </Sample>
      <Sample id="tooltip-title" state="After a page title">
        <PageHeader title="Reading sync" info={<InfoMark name="Reading sync" text={texts.readingSync} />} />
      </Sample>
      <Sample id="tooltip-several" state="Several in one group">
        <Group label="Audiobook">
          <Row label="Recordings" value="2" info={<InfoMark name="Recordings" text={texts.recordings} />} />
          <Row label="Available from" value="Server" info={<InfoMark name="Available from" text={texts.availableFrom} />} />
          <Row label="Plays from" value="Automatic" info={<InfoMark name="Plays from" text={texts.playsFrom} />} />
        </Group>
      </Sample>
      <Sample id="tooltip-icon-name" state="An icon without a label">
        <div className="gallery-row-of-buttons">
          <IconName name="Remove from this device">
            <Button
              kind="quiet"
              label="Remove from this device"
              icon={
                <Icon>
                  <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
                </Icon>
              }
              onClick={() => act("Remove from this device pressed")}
            />
          </IconName>
          <IconName name="Report a problem">
            <Button
              kind="quiet"
              label="Report a problem"
              icon={
                <Icon>
                  <path d="M5 21V4h11l-1 4 4 4H5" />
                </Icon>
              }
              onClick={() => act("Report a problem pressed")}
            />
          </IconName>
        </div>
      </Sample>
    </>
  ),
} satisfies GallerySection;
