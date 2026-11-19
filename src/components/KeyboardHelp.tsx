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
