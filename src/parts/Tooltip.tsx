// Tooltip (spec #480, "Parts"; #491; board Tooltips.dc.html). Two parts:
//
// - `InfoMark`: a circled i, 20 px and muted, after the name of a row, a group caption or a page title. A tap opens
//   the explanation under it (light fill, dark text, Label size, corner 8, at most 300 wide, a pointer to the mark);
//   a tap elsewhere, Escape or a second tap closes it. On a desktop it also opens on hover and on keyboard focus.
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

/** How long a hover may leave the mark (to reach the explanation) before it closes. */
const HOVER_GRACE_MS = 120;

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
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = () => {
    cancelClose();
    if (openMark === id) setOpenMark(null);
  };
  const show = (by: OpenedBy) => {
    cancelClose();
    openedBy.current = by;
    setOpenMark(id);
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(close, HOVER_GRACE_MS);
  };
  // A mark that leaves the page takes its explanation with it.
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (openMark === id) setOpenMark(null);
  }, [id]);

  const hoverIn = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (open) cancelClose();
    else show("hover");
  };
  const hoverOut = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && open && openedBy.current === "hover") closeSoon();
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? show("tap") : close())}>
      <Popover.Trigger
        className="part-info-mark"
        aria-label={label ?? `About ${name}`}
        aria-haspopup={undefined}
        aria-controls={open ? tipId : undefined}
        aria-describedby={open ? tipId : undefined}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
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
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") cancelClose();
          }}
          onPointerLeave={hoverOut}
        >
          {text}
          <Popover.Arrow className="part-tooltip-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** How long a pointer rests on an icon before its name shows, so passing over a row of icons shows nothing. */
const NAME_DELAY_MS = 300;

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
        onPointerEnter={(event: PointerEvent) => {
          if (event.pointerType !== "mouse") return;
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
