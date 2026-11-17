// The thin accent bar under a status line while something moves (File row, Book row, Steps). 4 high, round. It
// draws what the status line already says, so it is hidden from assistive technology.
import "./progress-bar.css";

export function ProgressBar({ progress }: { progress: number }) {
  const fraction = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return (
    <span className="part-progress" aria-hidden="true">
      <span className="part-progress-fill" style={{ width: `${fraction * 100}%` }} />
    </span>
  );
}
