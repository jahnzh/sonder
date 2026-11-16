// Steps (spec #480, "Parts"; boards LanguageFiles.dc.html, ReadingSync.dc.html): the stages of a piece of work, in
// order, on a surface card. Done: a green tick. Running: an accent dot, the label in bold and a bar under it. Not
// started: a ring and a muted label. Each step 36 high, with no lines between them; a figure on the right edge
// ("24 of 43 files") is optional. It is an ordered list; each step's mark is named by its state.
import { ProgressBar } from "./ProgressBar";
import { Tick } from "./icons";
import "./steps.css";

export type StepState = "done" | "running" | "waiting";
export type Step = {
  label: string;
  state: StepState;
  /** A figure on the right edge. */
  value?: string;
  /** 0 to 1, for a running step's bar. A running step without it shows no bar. */
  progress?: number | null;
};

/** The name each state's mark reads out (board ReadingSync.dc.html). */
export const stepStateName: Record<StepState, string> = { done: "Done", running: "Running", waiting: "Not started" };

function Mark({ state }: { state: StepState }) {
  return (
    <span className="part-step-mark" role="img" aria-label={stepStateName[state]}>
      {state === "done" ? <Tick className="part-step-tick" /> : <span className={state === "running" ? "part-step-dot" : "part-step-ring"} />}
    </span>
  );
}

export function Steps({ label, steps }: { label: string; steps: Step[] }) {
  return (
    <ol className="part-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={`${index}-${step.label}`} className="part-step" data-state={step.state}>
          <Mark state={step.state} />
          <span className="part-step-text">
            <span className="part-step-label type-body">{step.label}</span>
            {step.state === "running" && step.progress != null && <ProgressBar progress={step.progress} />}
          </span>
          {step.value && <span className="part-step-value type-label">{step.value}</span>}
        </li>
      ))}
    </ol>
  );
}
