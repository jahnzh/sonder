// The 20 px icons of the file and book rows (boards LanguageFiles.dc.html, Book.dc.html): headphones for an
// audiobook, an open book for an ebook, a chain link for a reading sync. Drawn in the current colour.
export type FileKind = "audiobook" | "ebook" | "sync";

/** The name a mark of a kind reads out where it stands without a label (a Book row's status line). */
export const fileKindName: Record<FileKind, string> = { audiobook: "Audiobook", ebook: "Ebook", sync: "Reading sync" };

const paths: Record<FileKind, string[]> = {
  audiobook: ["M4 14v-2a8 8 0 0 1 16 0v2", "M4 14h3v6H6a2 2 0 0 1-2-2zM20 14h-3v6h1a2 2 0 0 0 2-2z"],
  ebook: ["M12 6v14M12 6C10 4.5 7 4 4 4v14c3 0 6 .5 8 2M12 6c2-1.5 5-2 8-2v14c-3 0-6 .5-8 2"],
  sync: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
};

/** A kind's icon. Hidden from assistive technology unless it is given a `name`. */
export function FileIcon({ kind, size = 20, name }: { kind: FileKind; size?: number; name?: string }) {
  return (
    <svg
      className="part-file-icon"
      data-kind={kind}
      {...(name ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function Chevron() {
  return (
    <svg className="part-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function Tick({ className }: { className: string }) {
  return (
    <svg className={className} aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}
