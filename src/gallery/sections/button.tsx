// Button (spec #480, "Parts"): primary, secondary and quiet; enabled, disabled, with an icon, icon only.
import { Button, type ButtonKind } from "../../parts/Button";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

const kinds: [ButtonKind, string, string][] = [
  ["primary", "Primary", "Listen"],
  ["secondary", "Secondary", "Read"],
  ["quiet", "Quiet", "Cancel"],
];

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export default {
  id: "button",
  title: "Button",
  order: 30,
  render: ({ act }) =>
    kinds.map(([kind, name, text]) => (
      <Sample key={kind} id={`button-${kind}`} state={name}>
        <div className="gallery-row-of-buttons">
          <Button kind={kind} data-state="enabled" onClick={() => act(`${text} pressed`)}>
            {text}
          </Button>
          <Button kind={kind} data-state="disabled" disabled>
            {text}
          </Button>
          <Button kind={kind} data-state="icon" icon={<PlayIcon />} onClick={() => act(`${text} with an icon pressed`)}>
            {text}
          </Button>
          <Button kind={kind} data-state="icon-only" icon={<PlayIcon />} label={`${text} (icon only)`} onClick={() => act(`${text} icon pressed`)} />
        </div>
      </Sample>
    )),
} satisfies GallerySection;
