// One section of the parts gallery: one per part, in its own file under ./sections. The registry (./sections.ts)
// finds every file there, so adding a part adds a file and touches no other section.
import type { ReactNode } from "react";

export type GallerySection = {
  /** Names the section in the page (data-gallery-section) and in the browser spec. */
  id: string;
  /** The section's heading: the part's name. */
  title: string;
  /** Where the section stands on the page; lower first. */
  order: number;
  /** The part in each of its states. `act` reports what a sample did, for the status line under the header. */
  render: (tools: GalleryTools) => ReactNode;
};
export type GalleryTools = {
  /** Shows what a sample did ("Appearance pressed"), so keyboard use can be seen and tested. */
  act: (what: string) => void;
};
