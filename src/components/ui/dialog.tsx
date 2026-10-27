import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useId, type ReactNode } from "react";
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = "",
  onEscapeKeyDown,
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
  actions?: ReactNode;
  forceMount?: boolean;
}) {
  const descriptionId = useId();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal forceMount={forceMount ? true : undefined}>
        {open && <DialogPrimitive.Overlay className="dialog-overlay" />}
        <DialogPrimitive.Content
          forceMount={forceMount ? true : undefined}
          className={`dialog-content ${className}`}
          aria-describedby={description ? descriptionId : undefined}
          onEscapeKeyDown={onEscapeKeyDown}
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
