// Sheet (spec #480, "Parts"; glossary: Sheet; boards GetAudiobook.dc.html, SeriesAdd.dc.html): a full-screen task
// over a page. It has an address of its own (src/routes.ts), so opening it is a history entry and Back closes it;
// the page under it stays rendered where it was scrolled to. The head is Close, the task's name in the Caption
// style, and an empty 44 on the right; the body scrolls; the foot holds the one main button.
//
// While it is open the rest of the document is inert, focus is in the sheet, and Escape or Close goes back (to the
// page under it, or to the page's parent when the sheet was opened by a link). Closing returns focus to what opened it.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAddress } from "../navigation";
import type { Route } from "../routes";
import { Button } from "./Button";
import "./sheet.css";

export type SheetProps = {
  /** The task's name: shown in the head, and the dialog's name. */
  title: string;
  children: ReactNode;
  /** The foot, under the body: the one primary button and its note. */
  footer?: ReactNode;
  /** Where Close lands when no entry of the app lies behind (a link to the sheet): the sheet's parent by default. */
  parent?: Route;
};

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** What had focus when the sheet opened, if it was a control of the page (not the document itself). */
function opener(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && active !== document.documentElement ? active : null;
}

export function Sheet({ title, children, footer, parent }: SheetProps) {
  const { goBack } = useAddress();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = () => goBack(parent);

  useEffect(() => {
    const sheet = ref.current!;
    // Read before anything turns inert: a focused control inside an inert subtree loses its focus.
    const from = opener();
    const made = [...document.body.children].filter((element) => element !== sheet && !element.hasAttribute("inert"));
    for (const element of made) element.setAttribute("inert", "");
    sheet.focus({ preventScroll: true });
    return () => {
      for (const element of made) element.removeAttribute("inert");
      // The page under the sheet never moved: give focus back without scrolling it.
      if (from?.isConnected) from.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };

  return createPortal(
    <div ref={ref} className="part-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="part-sheet-column">
        <header className="part-sheet-head">
          <Button kind="secondary" icon={<CloseIcon />} label="Close" onClick={close} />
          <h2 id={titleId} className="part-sheet-title type-caption">
            {title}
          </h2>
          <span className="part-sheet-balance" aria-hidden="true" />
        </header>
        <div className="part-sheet-body">{children}</div>
        {footer && <div className="part-sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
