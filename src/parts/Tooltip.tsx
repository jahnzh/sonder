// Tooltip (spec #480, "Parts"; #491; board Tooltips.dc.html). Two parts:
//
// - `InfoMark`: a circled i, 20 px and muted, after the name of a row, a group caption or a page title. A tap opens
//   the explanation under it (light fill, dark text, Label size, corner 8, at most 300 wide, a pointer to the mark);
//   a tap elsewhere, Escape or a second tap closes it. On a desktop it also opens on keyboard focus, and on hover
//   once the pointer rests on the mark (a pointer passing over marks opens none).
//   One is open at a time in the whole app. It is never in the address: Back with one open leaves the page.
// - `IconName`: an icon without a label shows its name on hover (Caption size, one line).
//
// Both are built on the Radix popover primitive, the family of the dialog primitive the app already uses.
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactElement, type PointerEvent } from "react";
import "./tooltip.css";

// One open at a time: the id of the open explanation, shared by every mark.
let openMark: string | null = null;
const listeners = new Set<() => void>();
function setOpenMark(id: string | null) {
  if (openMark === id) return;
  openMark = id;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const currentMark = () => openMark;

/** How the open explanation was opened: a hover and a keyboard focus close with it; a tap stays until dismissed. */
type OpenedBy = "hover" | "focus" | "tap";

/** How long a mouse pointer rests on a mark before its explanation opens, so a pointer passing over a row of marks
 *  (or over the marks beside an explanation it is moving to) opens none. A tap and keyboard focus open at once. */
export const HOVER_OPEN_MS = 300;

/** Whether a point lies in the area a hover may cross without closing its explanation: the smallest box holding
 *  both the mark and the explanation, so the gap between them (and the entry the mark stands in) keeps it open. */
function inHoverArea(x: number, y: number, mark: Element | null, tip: Element | null) {
  const boxes = [mark, tip].filter((element): element is Element => element !== null).map((element) => element.getBoundingClientRect());
  if (boxes.length === 0) return false;
  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.right));
  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  return x >= left && x <= right && y >= top && y <= bottom;
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="10" cy="10" r="8.2" />
      <path d="M10 9v5" />
      <circle cx="10" cy="6.2" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export type InfoMarkProps = {
  /** The name of the entry the mark explains: the mark is named after it ("About Reading sync"). */
  name: string;
  /** The explanation: one to three sentences. */
  text: string;
  /** The mark's name, when "About <name>" does not fit. */
  label?: string;
};

export function InfoMark({ name, text, label }: InfoMarkProps) {
  const id = useId();
  const tipId = `${id}-tip`;
  const open = useSyncExternalStore(subscribe, currentMark, currentMark) === id;
  const openedBy = useRef<OpenedBy>("tap");
  const markRef = useRef<HTMLButtonElement>(null);
  const openTimer = useRef<number | null>(null);

  const cancelOpen = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const close = () => {
    cancelOpen();
    if (openMark === id) setOpenMark(null);
  };
  const show = (by: OpenedBy) => {
    cancelOpen();
    openedBy.current = by;
    setOpenMark(id);
  };
  // A mark that leaves the page takes its explanation with it.
  useEffect(() => () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (openMark === id) setOpenMark(null);
  }, [id]);

  // An explanation opened by a hover closes when the mouse pointer leaves the mark, the explanation and the gap
  // between them, or leaves the window. Where the pointer is decides, not a timer: a hand that pauses on its way
  // to the explanation keeps it, however long the pause.
  useEffect(() => {
    if (!open) return;
    const moved = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== "mouse" || openedBy.current !== "hover") return;
      if (!inHoverArea(event.clientX, event.clientY, markRef.current, document.getElementById(tipId))) close();
    };
    const left = (event: MouseEvent) => {
      if (event.relatedTarget === null && openedBy.current === "hover") close();
    };
    document.addEventListener("pointermove", moved, true);
    document.documentElement.addEventListener("mouseleave", left);
    return () => {
      document.removeEventListener("pointermove", moved, true);
      document.documentElement.removeEventListener("mouseleave", left);
    };
  });

  const hoverIn = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || open) return;
    cancelOpen();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      show("hover");
    }, HOVER_OPEN_MS);
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? show("tap") : close())}>
      <Popover.Trigger
        ref={markRef}
        className="part-info-mark"
        aria-label={label ?? `About ${name}`}
        aria-haspopup={undefined}
        aria-controls={open ? tipId : undefined}
        aria-describedby={open ? tipId : undefined}
        onPointerEnter={hoverIn}
        // A pointer that only passes over the mark opens nothing.
        onPointerLeave={cancelOpen}
        onFocus={(event) => {
          // Keyboard focus only: a tap focuses the mark too, and opens it by its click.
          if (!open && event.currentTarget.matches(":focus-visible")) show("focus");
        }}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (open && openedBy.current === "focus" && !document.getElementById(tipId)?.contains(next)) close();
        }}
        onClick={(event) => {
          // The mark decides itself instead of the primitive's toggle: a click on an explanation opened by hover
          // keeps it open; on one opened by a tap or by focus it closes it.
          event.preventDefault();
          if (open && openedBy.current !== "hover") close();
          else show("tap");
        }}
      >
        <InfoIcon />
      </Popover.Trigger>
      {/* Read out when it opens: a polite live region beside the mark, empty while it is closed. */}
      <span className="part-tooltip-live" aria-live="polite">
        {open ? text : ""}
      </span>
      <Popover.Portal>
        <Popover.Content
          id={tipId}
          role="tooltip"
          className="part-tooltip type-label"
          side="bottom"
          align="center"
          collisionPadding={16}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {text}
          <Popover.Arrow className="part-tooltip-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** How long a pointer rests on an icon before its name shows, so passing over a row of icons shows nothing. */
const NAME_DELAY_MS = HOVER_OPEN_MS;

export type IconNameProps = {
  /** The icon's name; the same words as the control's own name. */
  name: string;
  /** One control that shows only an icon (an icon-only Button). */
  children: ReactElement;
};

export function IconName({ name, children }: IconNameProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor
        asChild
        // A finger's pointerenter is followed at once by its pointerdown, which cancels the wait: a tap shows no name.
        onPointerEnter={() => {
          cancel();
          timer.current = window.setTimeout(() => setOpen(true), NAME_DELAY_MS);
        }}
        onPointerLeave={() => {
          cancel();
          setOpen(false);
        }}
        onPointerDown={() => {
          cancel();
          setOpen(false);
        }}
      >
        {children}
      </Popover.Anchor>
      <Popover.Portal>
        {/* The control is already named by the same words: the shown name is not read a second time. */}
        <Popover.Content
          className="part-icon-name type-caption"
          aria-hidden="true"
          side="bottom"
          align="center"
          sideOffset={4}
          collisionPadding={16}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {name}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
