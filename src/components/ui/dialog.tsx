import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { hideOthers } from "aria-hidden";
import { useEffect, useId, useRef, type ReactNode } from "react";
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = "",
  onEscapeKeyDown,
  onPointerDownOutside,
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
  actions?: ReactNode;
  forceMount?: boolean;
}) {
  const descriptionId = useId();
  const content = useRef<HTMLDivElement>(null);
  // A modal Radix dialog hides the rest of the page as soon as it mounts, even
  // while closed. A dialog kept mounted to stay warm is therefore non-modal,
  // and hides the page and draws its overlay itself only while open.
  useEffect(() => {
    if (!forceMount || !open || !content.current) return;
    const node = content.current;
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
  }, [forceMount, open]);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={!forceMount}>
      <DialogPrimitive.Portal forceMount={forceMount ? true : undefined}>
        {forceMount
          ? open && <div className="dialog-overlay" aria-hidden="true" />
          : <DialogPrimitive.Overlay className="dialog-overlay" />}
        <DialogPrimitive.Content
          ref={content}
          forceMount={forceMount ? true : undefined}
          className={`dialog-content ${className}`}
          aria-describedby={description ? descriptionId : undefined}
          onEscapeKeyDown={onEscapeKeyDown}
          onPointerDownOutside={onPointerDownOutside}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (
              !forceMount &&
              content.current &&
              !content.current.contains(document.activeElement)
            ) {
              content.current.focus({ preventScroll: true });
            }
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
