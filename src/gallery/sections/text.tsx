// The five text styles (spec #480, "Tokens").
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

const styles = [
  ["title", "Title", "Library"],
  ["heading", "Heading", "Continue listening"],
  ["body", "Body", "Default speed"],
  ["label", "Label", "Server copy"],
  ["caption", "Caption", "This device"],
] as const;

export default {
  id: "text",
  title: "Text styles",
  order: 0,
  render: () =>
    styles.map(([id, name, sample]) => (
      <Sample key={id} id={`text-${id}`} state={name}>
        <p className={`type-${id}`} data-text={id} style={{ margin: 0 }}>
          {sample}
        </p>
      </Sample>
    )),
} satisfies GallerySection;
