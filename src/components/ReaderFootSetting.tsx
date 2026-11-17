// Speed and the sleep timer in the reader's foot (#589, spec #586 "Speed and the sleep timer in the foot"; boards
// ReaderSpeed.dc.html, ReaderSleep.dc.html). The foot's Sleep timer and Speed buttons do not open a menu over the
// page: each puts its row, the label, a Stepper and Done, in place of the foot's transport row for a moment. The
// timeline above stays, and the foot keeps its box, so nothing is covered and the text is not laid out again.
import { useEffect, useRef, useState } from "react";
import { Moon } from "lucide-react";
import { Button } from "../parts/Button";
import { Stepper } from "../parts/Stepper";
import { useBookSpeed, useHasOwnSpeed, usePlayer } from "../player";
import { SPEED_MAX, SPEED_MIN, SPEED_STEP, formatSpeed } from "../playback-speed";
import { formatSleep, SLEEP_MAX, SLEEP_OFF, sleepFromStepper, sleepShown } from "../sleep-stepper";
import "../reader-foot-setting.css";

export type FootSetting = "speed" | "sleep";

/** Which setting holds the foot's row, if any. Hiding the controls puts the transport row back. */
export function useFootSetting(controls: boolean) {
  const [setting, setSetting] = useState<FootSetting | null>(null);
  useEffect(() => {
    if (!controls) setSetting(null);
  }, [controls]);
  return [controls ? setting : null, setSetting] as const;
}

/** The foot's Sleep timer and Speed buttons: the minutes left while the timer runs, and the speed. */
export function FootSettingButtons({ open, onOpen }: { open: FootSetting | null; onOpen: (setting: FootSetting) => void }) {
  const p = usePlayer();
  const speed = useBookSpeed(undefined);
  const minutes = sleepShown(p.sleep);
  const sleepButton = useRef<HTMLButtonElement>(null), speedButton = useRef<HTMLButtonElement>(null);
  // Done (or the controls hiding) puts the buttons back: focus returns to the one that was used.
  const last = useRef<FootSetting | null>(null);
  useEffect(() => {
    const was = last.current;
    last.current = open;
    if (!open && was && (document.activeElement === document.body || !document.activeElement))
      (was === "sleep" ? sleepButton : speedButton).current?.focus();
  }, [open]);
  return (
    <>
      <button
        ref={sleepButton}
        type="button"
        className="icon-button reader-foot-sleep"
        aria-label={minutes === SLEEP_OFF ? "Sleep timer: off" : `Sleep timer: ${formatSleep(minutes)} left`}
        aria-expanded={open === "sleep"}
        data-running={minutes !== SLEEP_OFF || undefined}
        onClick={() => onOpen("sleep")}
      >
        {minutes === SLEEP_OFF ? <Moon size={20} aria-hidden="true" /> : <span aria-hidden="true">{formatSleep(minutes)}</span>}
      </button>
      <button
        ref={speedButton}
        type="button"
        className="icon-button reader-foot-speed"
        aria-label={`Speed ${formatSpeed(speed)} times`}
        aria-expanded={open === "speed"}
        onClick={() => onOpen("speed")}
      >
        <span aria-hidden="true">{formatSpeed(speed)}×</span>
      </button>
    </>
  );
}

/** The row that takes the transport row's place: "Speed" or "Sleep timer", its Stepper, Done. */
export function FootSettingRow({ setting, onDone }: { setting: FootSetting; onDone: () => void }) {
  const row = useRef<HTMLDivElement>(null);
  // The row replaces the button that opened it: the keyboard carries on at its value.
  useEffect(() => {
    row.current?.querySelector<HTMLElement>('[role="spinbutton"]')?.focus();
  }, [setting]);
  return (
    <div ref={row} className="reader-foot-setting" role="group" aria-label={setting === "speed" ? "Speed" : "Sleep timer"}>
      {setting === "speed" ? <SpeedSetting /> : <SleepSetting />}
      <Button kind="quiet" className="reader-foot-setting-done" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

// Today's speeds: 0.5× to 3× in steps of 0.05, remembered for the recording in the player on this device, and
// "Use default" while the recording has a speed of its own (the speed menu's entry, as today).
function SpeedSetting() {
  const p = usePlayer();
  const speed = useBookSpeed(undefined);
  const own = useHasOwnSpeed(undefined);
  return (
    <>
      <span className="reader-foot-setting-label type-body">Speed</span>
      {own.recordingId && own.has && (
        <Button
          kind="quiet"
          className="reader-foot-setting-default"
          aria-label={`Use default · ${formatSpeed(p.defaultSpeed)}×`}
          onClick={() => p.resetSpeed(own.recordingId!)}
        >
          Use default
        </Button>
      )}
      <Stepper
        label="Playback speed"
        value={speed}
        min={SPEED_MIN}
        max={SPEED_MAX}
        step={SPEED_STEP}
        format={(value) => `${formatSpeed(value)}×`}
        decreaseLabel="Slower"
        increaseLabel="Faster"
        onChange={(value) => p.setSpeed(value)}
      />
    </>
  );
}

// Off, 5, 15, 30, 45, 60 minutes; while it runs, the minutes left. When it ends the player pauses the narration.
function SleepSetting() {
  const p = usePlayer();
  const shown = sleepShown(p.sleep);
  return (
    <>
      <span className="reader-foot-setting-label type-body">Sleep timer</span>
      <Stepper
        label="Sleep timer"
        value={shown}
        min={SLEEP_OFF}
        max={SLEEP_MAX}
        step={1}
        format={formatSleep}
        decreaseLabel="Shorter"
        increaseLabel="Longer"
        onChange={(next) => {
          const minutes = sleepFromStepper(shown, next);
          if (minutes !== undefined) p.setSleep(minutes);
        }}
      />
    </>
  );
}
