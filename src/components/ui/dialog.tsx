import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { hideOthers } from "aria-hidden";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
/**
 * The first and last element of `container` that Tab stops at, as Radix's focus scope finds them: an element with a
 * tab index of 0 or more that is not disabled, not a hidden input and visible (`checkVisibility`, or not under
 * `display: none` or `visibility: hidden` inside the container where the browser has none). Null when it has none.
 */
function tabEdges(container: HTMLElement): { first: HTMLElement; last: HTMLElement } | null {
  const candidates: HTMLElement[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (item) => {
      const element = item as HTMLElement & { disabled?: boolean; type?: string };
      if (element.disabled || element.hidden || (element.tagName === "INPUT" && element.type === "hidden")) return NodeFilter.FILTER_SKIP;
      return element.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) candidates.push(walker.currentNode as HTMLElement);
  const checks = typeof container.checkVisibility === "function" && container.checkVisibility({ checkVisibilityCSS: true });
  const shown = (element: HTMLElement) => {
    if (checks) return element.checkVisibility({ checkVisibilityCSS: true });
    if (getComputedStyle(element).visibility === "hidden") return false;
    for (let item: HTMLElement | null = element; item && item !== container; item = item.parentElement)
      if (getComputedStyle(item).display === "none") return false;
    return true;
  };
  const first = candidates.find(shown);
  const last = [...candidates].reverse().find(shown);
  return first && last ? { first, last } : null;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = "",
  onEscapeKeyDown,
  onPointerDownOutside,
  onCloseAutoFocus,
  actions,
  forceMount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: (event: CustomEvent<{ originalEvent: PointerEvent }>) => void;
  onCloseAutoFocus?: (event: Event) => void;
  actions?: ReactNode;
  forceMount?: boolean;
}) {
  const descriptionId = useId();
  const content = useRef<HTMLDivElement | null>(null);
  // The portal renders its content only after it has mounted, so a dialog that mounts open (the reader on its own,
  // #590) gets its node a render later: the effect below waits for it.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const contentRef = useCallback((element: HTMLDivElement | null) => {
    content.current = element;
    setNode(element);
  }, []);
  // A dialog kept mounted listens for presses outside it while closed too, and Radix answers a press only at its
  // click: a press that opened this dialog (a row of the reader's pages, #590) would close it again at once. Only
  // a press that began while the dialog was open closes it.
  const openNow = useRef(open);
  openNow.current = open;
  const openAtPress = useRef(open);
  useEffect(() => {
    if (!forceMount) return;
    const press = () => {
      openAtPress.current = openNow.current;
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [forceMount]);
  // Tab and Shift+Tab wrap at the dialog's ends here, not only in Radix's focus scope: an info mark's explanation is a
  // Radix popover, whose scope pauses the dialog's while it is open and gives it back only in a timer after it closes.
  // A Tab that came before that timer (the focus had moved from the mark to the last control) left the dialog for the
  // page behind it, which is inert, so the focus fell to the body (#737). Radix's own wrap then finds nothing to do.
  useEffect(() => {
    if (!node) return;
    const wrap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      const edges = tabEdges(node);
      if (!edges) return;
      const target = event.shiftKey
        ? (document.activeElement === edges.first ? edges.last : null)
        : (document.activeElement === edges.last ? edges.first : null);
      if (!target) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
    };
    node.addEventListener("keydown", wrap);
    return () => node.removeEventListener("keydown", wrap);
  }, [node]);
  // A modal Radix dialog hides the rest of the page as soon as it mounts, even
  // while closed. A dialog kept mounted to stay warm is therefore non-modal,
  // and hides the page and draws its overlay itself only while open.
  useEffect(() => {
    if (!forceMount || !open || !node) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      !node.contains(document.activeElement)
        ? document.activeElement
        : null;
    node.focus({ preventScroll: true });
    const restoreHidden = hideOthers(node);
    const hidden = Array.from(document.querySelectorAll<HTMLElement>('[data-aria-hidden="true"]'));
    const previouslyInert = hidden.map(item => item.inert);
    hidden.forEach(item => { item.inert = true; });
    return () => {
      hidden.forEach((item, index) => { item.inert = previouslyInert[index]; });
      restoreHidden();
      const visible = (el: HTMLElement | null) =>
        !!el &&
        el.isConnected &&
        el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== "hidden";
      const target = visible(previousFocus)
        ? previousFocus
        : document.querySelector<HTMLElement>(
            ".player-dock .dock-book, .player-dock button:not([disabled])",
          );
      if (
        !document.activeElement ||
        document.activeElement === document.body ||
        node.contains(document.activeElement) ||
        !visible(document.activeElement as HTMLElement)
      ) {
        if (visible(target)) target!.focus({ preventScroll: true });
        else (document.activeElement as HTMLElement | null)?.blur?.();
      }
    };
  }, [forceMount, open, node]);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={!forceMount}>
      <DialogPrimitive.Portal forceMount={forceMount ? true : undefined}>
        {forceMount
          ? open && <div className="dialog-overlay" aria-hidden="true" />
          : <DialogPrimitive.Overlay className="dialog-overlay" />}
        <DialogPrimitive.Content
          ref={contentRef}
          forceMount={forceMount ? true : undefined}
          className={`dialog-content ${className}`}
          aria-describedby={description ? descriptionId : undefined}
          onEscapeKeyDown={onEscapeKeyDown}
          onPointerDownOutside={(event) => {
            if (forceMount && !openAtPress.current) {
              event.preventDefault();
              return;
            }
            onPointerDownOutside?.(event);
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (forceMount || !content.current) return;
            // A dialog with a text field starts in it; any other dialog starts
            // on the container so Space does not activate a focused button.
            const field = content.current.querySelector<HTMLElement>(
              'textarea:not([disabled]), input:not([disabled]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])',
            );
            (field ?? content.current).focus({ preventScroll: true });
          }}
        >
          <div className="dialog-heading">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description id={descriptionId}>
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            {actions && <div className="dialog-actions">{actions}</div>}
            <DialogPrimitive.Close
              className="icon-button"
              aria-label="Close dialog"
            >
              <X size={20} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
