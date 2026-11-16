// The gallery's registry: every section module under ./sections, in their order. A part's worker adds one file
// there that default-exports a GallerySection; nothing here changes.
import type { GallerySection } from "./section";

const modules = import.meta.glob<{ default: GallerySection }>("./sections/*.tsx", { eager: true });

export const sections: GallerySection[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
