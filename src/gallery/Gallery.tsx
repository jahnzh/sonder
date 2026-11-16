// The parts gallery (#486): every part in every state, at `#gallery`, which no navigation links to; and its child
// page at `#gallery/child`, where the Page header's back button can be tried. It is shown instead of the app's
// shell, so nothing of the shell covers a part.
import { useState } from "react";
import { useAddress } from "../navigation";
import { PageHeader } from "../parts/PageHeader";
import { sections } from "./sections";
import "./gallery.css";

export function isGalleryRoute(name: string) {
  return name === "gallery" || name === "gallery-child";
}

function GalleryIndex() {
  const [status, setStatus] = useState("");
  const tools = { act: setStatus };
  return (
    <main className="gallery-page" aria-label="Gallery">
      <PageHeader title="Gallery" />
      <p className="gallery-status type-label" role="status">
        {status}
      </p>
      {sections.map((section) => (
        <section key={section.id} className="gallery-section" data-gallery-section={section.id} aria-labelledby={`gallery-${section.id}`}>
          <h2 id={`gallery-${section.id}`} className="gallery-section-title type-heading">
            {section.title}
          </h2>
          {section.render(tools)}
        </section>
      ))}
    </main>
  );
}

function GalleryChild() {
  return (
    <main className="gallery-page" aria-label="Child page">
      <PageHeader title="Child page" back />
    </main>
  );
}

export function Gallery() {
  const { route } = useAddress();
  return route.name === "gallery-child" ? <GalleryChild /> : <GalleryIndex />;
}
