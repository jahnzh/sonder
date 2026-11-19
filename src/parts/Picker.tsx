// Picker (glossary "Picker"; spec #572 "The Picker part"; boards LibrarySort.dc.html, LibraryShelf.dc.html; built by
// #529 inside the Hardcover page, moved here by #602 for Get audiobook's language, grown by #578 for the Library's
// sort-and-view control). A short panel of choices over the page, announced as a dialog named after what it chooses.
// On a phone it rises from the bottom edge over a dimmed page; on a desktop (760 wide and more) it opens under the
// button that opened it. It has no address (#455): Back leaves the page under it. Escape, Done and a tap outside
// close it; focus moves in and returns to the button that opened it.
//
// Its rows: choice rows (`PickerChoices`, one radio row per choice with a tick on the chosen one), a Segmented
// control, and picker rows (`PickerRow`, a row whose value opens a second list inside the same picker; that list has
// a back button to the first). `Picker` is the one-list form: a choice applies at once and closes it.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "./Button";
import { Tick } from "./icons";
import { PICKER_DESKTOP_WIDTH, pickerPlace } from "./picker-place";
import "./picker.css";

export type PickerOption<T extends string> = {
  value: T;
  label: string;
  /** A short muted text on the right edge (a list's count); read out after the label. */
  detail?: string | null;
};

/** A second list shown in place of the first, inside the same picker, with a back button to the first. */
export type PickerSub = {
  /** The second list's name: its heading, and the name of the list. */
  title: string;
  content: ReactNode;
  /** Back to the first list. */
  onBack: () => void;
};

export type PickerDialogProps = {
  open: boolean;
  /** What the picker chooses: the dialog's name. */
  title: string;
  onClose: () => void;
  /** The button that opens it: on a desktop the picker opens under it. Without one it stands in the middle. */
  anchor?: RefObject<HTMLElement | null>;
  /** A second list open in place of the first. */
  sub?: PickerSub | null;
  children: ReactNode;
  className?: string;
};

function wide(): boolean {
  return typeof window !== "undefined" && window.innerWidth >= PICKER_DESKTOP_WIDTH;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function PickerDialog({ open, title, onClose, anchor, sub, children, className }: PickerDialogProps) {
  // The control that opened it gets the focus back when it closes (it opens without a Radix trigger).
  // Read while rendering the opening: the dialog's own effects move the focus in before an effect here would run.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpen.current = open;
  const content = useRef<HTMLDivElement | null>(null);
  // The portal mounts its content a render after the dialog opens: the node, kept as state, renders the picker
  // again once it is there, so it is placed under its button before it is painted.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const contentRef = useCallback((element: HTMLDivElement | null) => {
    content.current = element;
    setNode(element);
  }, []);
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const placeIt = () => {
    const button = anchor?.current;
    const panel = content.current;
    const next = open && button && panel && wide() ? pickerPlace(button.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, panel.offsetWidth) : null;
    // Set only when it moved: a new object every time would render again for ever.
    setPlace((now) => (now === next || (now && next && now.top === next.top && now.left === next.left && now.maxHeight === next.maxHeight) ? now : next));
  };
  useLayoutEffect(placeIt, [open, node, anchor, sub]);
  useEffect(() => {
    if (!open) return;
    // The window resized, or the page under it scrolled after it opened (the button moved): stand under it again.
    window.addEventListener("resize", placeIt);
    window.addEventListener("scroll", placeIt, true);
    // The page above the button grew or shrank after it opened (a card that arrived late moved the button).
    const grown = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => placeIt());
    grown?.observe(document.body);
    return () => {
      window.removeEventListener("resize", placeIt);
      window.removeEventListener("scroll", placeIt, true);
      grown?.disconnect();
    };
  });
  // Opening or leaving the second list moves the focus to its first control, so a keyboard follows the change.
  const subTitle = sub?.title ?? null;
  const shownSub = useRef<string | null>(null);
  useEffect(() => {
    if (!open || shownSub.current === subTitle) return;
    const was = shownSub.current;
    shownSub.current = subTitle;
    const panel = content.current;
    if (!panel) return;
    if (subTitle) panel.querySelector<HTMLElement>(".part-picker-list [aria-checked='true'], .part-picker-list button")?.focus({ preventScroll: true });
    else if (was) panel.querySelector<HTMLElement>(`[data-picker-row="${CSS.escape(was)}"]`)?.focus({ preventScroll: true });
  }, [open, subTitle]);
  useEffect(() => {
    if (!open) shownSub.current = null;
  }, [open]);
  const anchored = !!anchor;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="part-picker-overlay" data-anchored={anchored ? "" : undefined} />
        <DialogPrimitive.Content
          ref={contentRef}
          className={["part-picker", className].filter(Boolean).join(" ")}
          data-anchored={anchored ? "" : undefined}
          data-placed={place ? "" : undefined}
          style={place ? { top: place.top, left: place.left, maxHeight: place.maxHeight } : undefined}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            // The chosen row when there is one, so a keyboard starts where the choice is; else the panel itself.
            const panel = content.current;
            const chosen = panel?.querySelector<HTMLElement>("[aria-checked='true']");
            (chosen ?? panel)?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            const back = opener.current;
            opener.current = null;
            if (back?.isConnected) {
              event.preventDefault();
              back.focus({ preventScroll: true });
            }
          }}
          tabIndex={-1}
          onKeyDown={(event) => {
            // Its own Escape: Now playing's dialog stays mounted while the dock has a book, and a layer Radix mounts
            // after this one (the dock getting its book) takes Escape from it. Handled here, it closes the picker
            // only; a Sheet under it sees it handled and stays (Sheet.tsx).
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
          }}
        >
          <div className="part-picker-head">
            {sub && <Button className="part-picker-back" icon={<BackIcon />} label={`Back to ${title}`} onClick={sub.onBack} />}
            <DialogPrimitive.Title className="part-picker-title type-heading">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button className="part-picker-done">Done</Button>
            </DialogPrimitive.Close>
          </div>
          {sub ? (
            <div className="part-picker-sub" role="group" aria-label={sub.title}>
              <h2 className="part-picker-caption type-caption">{sub.title}</h2>
              {sub.content}
            </div>
          ) : (
            children
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A group of the picker with its caption (Sort, View, Hardcover). */
export function PickerGroup({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <section className="part-picker-group" aria-label={caption}>
      <h2 className="part-picker-caption type-caption" aria-hidden="true">
        {caption}
      </h2>
      {children}
    </section>
  );
}

/** Choice rows: a radio group on a card, one row per choice, the chosen one in bold with the accent's tick. */
export function PickerChoices<T extends string>({
  label,
  options,
  value,
  onChoose,
}: {
  /** The list's name. */
  label: string;
  options: readonly PickerOption<T>[];
  value: T | null;
  /** A row was chosen (also the one already chosen). */
  onChoose: (value: T) => void;
}) {
  return (
    <ul className="part-picker-list" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const chosen = option.value === value;
        return (
          <li key={option.value}>
            <button
              type="button"
              role="radio"
              aria-checked={chosen}
              aria-label={option.detail ? `${option.label} · ${option.detail}` : undefined}
              className="part-picker-choice type-body"
              data-chosen={chosen ? "" : undefined}
              onClick={() => onChoose(option.value)}
            >
              <span className="part-picker-label">{option.label}</span>
              {option.detail && (
                <span className="part-picker-detail type-label" aria-hidden="true">
                  {option.detail}
                </span>
              )}
              {chosen && <Tick className="part-picker-tick" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Picker rows on one card: each names a choice and shows its value; a tap opens that choice's own list. */
export function PickerRows({ children }: { children: ReactNode }) {
  return <ul className="part-picker-list">{children}</ul>;
}

/** A picker row ("Shelf  All shelves ⌄"), named "Shelf: All shelves"; it opens its own list in the same picker. */
export function PickerRow({ label, value, onOpen }: { label: string; value: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="part-picker-row type-body" aria-label={`${label}: ${value}`} aria-haspopup="true" data-picker-row={label} onClick={onOpen}>
        <span className="part-picker-label">{label}</span>
        <span className="part-picker-value type-label">
          {value}
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
    </li>
  );
}

export type PickerProps<T extends string> = {
  open: boolean;
  /** What the picker chooses: the dialog's name and its list's. */
  title: string;
  options: readonly PickerOption<T>[];
  value: T | null;
  onClose: () => void;
  /** A choice other than the one shown. */
  onChoose: (value: T) => void;
};

/** The one-list picker (#529's shelf, #602's language): a choice applies at once and closes it. */
export function Picker<T extends string>({ open, title, options, value, onClose, onChoose }: PickerProps<T>) {
  return (
    <PickerDialog open={open} title={title} onClose={onClose}>
      <PickerChoices
        label={title}
        options={options}
        value={value}
        onChoose={(chosen) => {
          onClose();
          if (chosen !== value) onChoose(chosen);
        }}
      />
    </PickerDialog>
  );
}
