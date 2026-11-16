// One state of a part on the gallery, with the name of the state above it.
import type { ReactNode } from "react";

export function Sample({ id, state, children }: { id: string; state: string; children: ReactNode }) {
  return (
    <div className="gallery-sample" data-sample={id}>
      <p className="gallery-state type-caption">{state}</p>
      {children}
    </div>
  );
}
