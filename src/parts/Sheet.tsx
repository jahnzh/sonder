// Sheet (spec #480, "Parts"; glossary: Sheet; boards GetAudiobook.dc.html, SeriesAdd.dc.html): a full-screen task
// over a page. It has an address of its own (src/routes.ts), so opening it is a history entry and Back closes it;
// the page under it stays rendered where it was scrolled to. The head is Close, the task's name in the Caption
// style, and an empty 44 on the right; the body scrolls; the foot holds the one main button.
//
// While it is open the rest of the document is inert, focus is in the sheet, and Escape or Close goes back (to the
// page under it, or to the page's parent when the sheet was opened by a link). Closing returns focus to what opened it.
// A sheet shown before anyone is signed in (Request an account, #582) has no address: it closes with `onClose`, and
// then never reads or writes the history, so the address asked for survives until the sign-in.
//
// The sheet covers what the screen shows (the visual viewport), so a phone's keyboard never covers its body or its
// foot.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { goBack } from "../navigation";
import type { Route } from "../routes";
import { Button } from "./Button";
import { shownRoom } from "./shown-room";
import "./sheet.css";

export type SheetProps = {
  /** The task's name: shown in the head, and the dialog's name. */
  title: string;
  children: ReactNode;
  /** The foot, under the body: the one primary button and its note. */
  footer?: ReactNode;
  /** Where Close lands when no entry of the app lies behind (a link to the sheet): the sheet's parent by default. */
  parent?: Route;
  /** Closes a sheet that has no address of its own; without it, Close and Escape go back in the history. */
  onClose?: () => void;
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

export function Sheet({ title, children, footer, parent, onClose }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = () => (onClose ? onClose() : goBack(parent));

  useEffect(() => {
    const view = window.visualViewport;
    const sheet = ref.current;
    if (!view || !sheet) return;
    const fit = () => {
      const room = shownRoom(view, window.innerHeight);
      sheet.style.setProperty("--sheet-shown-top", `${room.top}px`);
      sheet.style.setProperty("--sheet-shown-bottom", `${room.bottom}px`);
    };
    // The browser scrolls the field being typed in back into sight once the sheet has shrunk.
    fit();
    view.addEventListener("resize", fit);
    view.addEventListener("scroll", fit);
    return () => {
      view.removeEventListener("resize", fit);
      view.removeEventListener("scroll", fit);
    };
  }, []);

  useEffect(() => {
    const sheet = ref.current!;
    // Read before anything turns inert: a focused control inside an inert subtree loses its focus.
    const from = opener();
    // A sheet over this one (the magnet sheet over Get, #606) comes after it in the document: when both open at once
    // (a link), it is left alone, and it makes this one inert itself.
    const over = (element: Element) =>
      element.classList.contains("part-sheet") && !!(sheet.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    const made = [...document.body.children].filter((element) => element !== sheet && !element.hasAttribute("inert") && !over(element));
    for (const element of made) element.setAttribute("inert", "");
    sheet.focus({ preventScroll: true });
    return () => {
      for (const element of made) element.removeAttribute("inert");
      // The page under the sheet never moved: give focus back without scrolling it.
      if (from?.isConnected) from.focus({ preventScroll: true });
    };
  }, []);

  // Whether an explanation was open when Escape went down, read before any layer closes it.
  const explanationOpen = useRef(false);
  useEffect(() => {
    const read = (event: globalThis.KeyboardEvent) => {
      // A Picker (#602's language) is a layer of its own over the sheet: it takes Escape too.
      if (event.key === "Escape") explanationOpen.current = !!document.querySelector("[data-radix-popper-content-wrapper], .part-picker");
    };
    window.addEventListener("keydown", read, true);
    return () => window.removeEventListener("keydown", read, true);
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // An explanation or a Picker open over the sheet takes Escape first. Now playing's dialog stays mounted while closed whenever the
    // dock has a book, and Radix marks every Escape it sees as handled even then: that one does not keep the sheet open.
    if (event.defaultPrevented && explanationOpen.current) return;
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
