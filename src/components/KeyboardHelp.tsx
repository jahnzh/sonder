import { useState } from "react";
import { Keyboard } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { KEYBOARD_SHORTCUTS } from "../keyboard";
export function KeyboardHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      className="keyboard-help-dialog"
    >
      <dl className="keyboard-shortcuts">
        {KEYBOARD_SHORTCUTS.map(({ keys, action }) => (
          <div key={action}>
            <dt>
              {keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dt>
            <dd>
              <span>{action}</span>
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
/** The button and its dialog. Pass `open` and `onOpenChange` where the dialog must close with what holds it. */
export function KeyboardHelpButton({
  className = "button subtle",
  open: shown,
  onOpenChange,
}: {
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Keyboard size={16} /> Keyboard shortcuts
      </button>
      <KeyboardHelpDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
