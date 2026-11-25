// Speed and the sleep timer in the reader's foot (#589, #890; ADR 0019 amended 2026-11-24, "a setting's pop-up";
// boards ReaderSpeed.dc.html, ReaderSleep.dc.html). A tap on the foot's Sleep timer or Speed button opens a pop-up
// above the foot, anchored to that button: the label and its Stepper (for Speed also "Use default"), each change
// applied at once. The transport row stays underneath and usable. It is the one thing drawn over the book's text,
// and only so: it opens on the reader's own tap on its button, reaches at most 120 px into the text band, dims
// nothing and lays nothing out again; a tap outside it, Escape, its button again or the controls hiding closes it.
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Moon } from "lucide-react";
import { Button } from "../parts/Button";
import { Stepper } from "../parts/Stepper";
import { useBookSpeed, useHasOwnSpeed, usePlayer } from "../player";
import { SPEED_MAX, SPEED_MIN, SPEED_STEP, formatSpeed } from "../playback-speed";
import { formatSleep, SLEEP_MAX, SLEEP_OFF, sleepFromStepper, sleepShown } from "../sleep-stepper";
import "../reader-foot-setting.css";

export type FootSetting = "speed" | "sleep";

/** Which setting's pop-up is open, if any. Hiding the controls closes it. */
export function useFootSetting(controls: boolean) {
  const [setting, setSetting] = useState<FootSetting | null>(null);
  useEffect(() => {
    if (!controls) setSetting(null);
  }, [controls]);
  return [controls ? setting : null, setSetting] as const;
}

// What a press outside the pop-up must leave to its own click: the two setting buttons decide by themselves (the
// same button closes it, the other switches), and the catcher over the text closes it and does nothing else.
const LEFT_TO_CLICK = ".reader-foot-sleep, .reader-foot-speed, .reader-text-catcher";

/**
 * The foot's Sleep timer and Speed buttons, the minutes left while the timer runs and the speed, each with its pop-up.
 * `onOpen(null)` closes the one open.
 */
export function FootSettingButtons({ open, onOpen }: { open: FootSetting | null; onOpen: (setting: FootSetting | null) => void }) {
  const p = usePlayer();
  const speed = useBookSpeed(undefined);
  const minutes = sleepShown(p.sleep);
  const sleepButton = useRef<HTMLButtonElement>(null), speedButton = useRef<HTMLButtonElement>(null);
  // The pop-up stands on the foot's top edge: its distance from the button's top, measured when it opens.
  const [offset, setOffset] = useState(0);
  const toggle = (setting: FootSetting, button: HTMLButtonElement) => {
    if (open === setting) {
      button.focus();
      onOpen(null);
      return;
    }
    const foot = button.closest(".reader-player");
    setOffset(foot ? Math.max(0, button.getBoundingClientRect().top - foot.getBoundingClientRect().top) : 0);
    onOpen(setting);
  };
  const popup = (setting: FootSetting, button: RefObject<HTMLButtonElement | null>) => (
    <SettingPopup
      setting={setting}
      offset={offset}
      onEscape={() => {
        button.current?.focus();
        onOpen(null);
      }}
      onOutside={() => onOpen(null)}
    />
  );
  return (
    <>
      <Popover.Root open={open === "sleep"}>
        <Popover.Anchor asChild>
          <button
            ref={sleepButton}
            type="button"
            className="icon-button reader-foot-sleep"
            aria-label={minutes === SLEEP_OFF ? "Sleep timer: off" : `Sleep timer: ${formatSleep(minutes)} left`}
            aria-expanded={open === "sleep"}
            data-running={minutes !== SLEEP_OFF || undefined}
            onClick={(event) => toggle("sleep", event.currentTarget)}
          >
            {minutes === SLEEP_OFF ? <Moon size={20} aria-hidden="true" /> : <span aria-hidden="true">{formatSleep(minutes)}</span>}
          </button>
        </Popover.Anchor>
        {popup("sleep", sleepButton)}
      </Popover.Root>
      <Popover.Root open={open === "speed"}>
        <Popover.Anchor asChild>
          <button
            ref={speedButton}
            type="button"
            className="icon-button reader-foot-speed"
            aria-label={`Speed ${formatSpeed(speed)} times`}
            aria-expanded={open === "speed"}
            onClick={(event) => toggle("speed", event.currentTarget)}
          >
            <span aria-hidden="true">{formatSpeed(speed)}×</span>
          </button>
        </Popover.Anchor>
        {popup("speed", speedButton)}
      </Popover.Root>
    </>
  );
}

/**
 * The pop-up: a group named "Speed" or "Sleep timer", not a dialog, with no backdrop and no Done. It is rendered where
 * it is declared, inside the foot, not in a portal on the document's body: everything of a reader stays inside its own
 * room, so the inline reader of Now playing and another reader never mix their pop-ups, and the foot's own handlers
 * (a tap on a control ends a notice) see it. No portal is needed for layering: it is positioned fixed above the foot,
 * inside the room's box, and stands above the text band and its catcher by its z-index.
 */
function SettingPopup({ setting, offset, onEscape, onOutside }: { setting: FootSetting; offset: number; onEscape: () => void; onOutside: () => void }) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <Popover.Content
      ref={content}
      role="group"
      aria-label={setting === "speed" ? "Speed" : "Sleep timer"}
      className="reader-foot-popup"
      data-setting={setting}
      side="top"
      align="end"
      sideOffset={offset}
      collisionPadding={16}
      // The keyboard carries on at the value, as when the row took the transport row's place.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        content.current?.querySelector<HTMLElement>('[role="spinbutton"]')?.focus();
      }}
      // Escape and the button put the focus back on the button themselves; a tap elsewhere keeps it where it went.
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        onEscape();
      }}
      onInteractOutside={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(LEFT_TO_CLICK)) {
          event.preventDefault();
          return;
        }
        onOutside();
      }}
    >
      {setting === "speed" ? <SpeedSetting /> : <SleepSetting />}
    </Popover.Content>
  );
}

/**
 * How long after a press on the text ends the catcher waits for its click before closing the pop-up by itself. A tap
 * is followed by a click, which closes it at once; a press that moved (a swipe) is followed by none, so without this
 * the pop-up would stay open. The catcher stays until then so that the click of a touch never reaches the text beneath.
 */
const LATE_CLOSE_MS = 350;

/**
 * Over the text band while a setting pop-up is open: draws nothing, and takes the tap meant for the text, so that the
 * tap only closes the pop-up. It must not also show or hide the controls, turn a page, follow a link, start Listen
 * from here or move the rail. The view of prepared text never sees it. The reader mounts one per
 * open setting (keyed by it), so a late close left by one setting's catcher never closes the next.
 */
export function TextCatcher({ viewport, onClose }: { viewport: RefObject<HTMLElement | null>; onClose: () => void }) {
  const late = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (late.current) clearTimeout(late.current);
    late.current = null;
  };
  useEffect(() => cancel, []);
  const element = viewport.current;
  if (!element) return null;
  const close = () => {
    cancel();
    onClose();
  };
  return (
    <div
      className="reader-text-catcher"
      aria-hidden="true"
      style={{ left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight }}
      onPointerDown={(event) => {
        cancel();
        event.preventDefault();
      }}
      onPointerUp={() => {
        cancel();
        late.current = setTimeout(close, LATE_CLOSE_MS);
      }}
      onPointerCancel={close}
      onClick={close}
      onWheel={close}
    />
  );
}

// Today's speeds: 0.5× to 3× in steps of 0.05, remembered for the recording in the player on this device, and
// "Use default" while the recording has a speed of its own (the speed menu's entry, as today).
function SpeedSetting() {
  const p = usePlayer();
  const speed = useBookSpeed(undefined);
  const own = useHasOwnSpeed(undefined);
  return (
    <div className="reader-foot-setting">
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
    </div>
  );
}

// Off, 5, 15, 30, 45, 60 minutes; while it runs, the minutes left. When it ends the player pauses the narration.
function SleepSetting() {
  const p = usePlayer();
  const shown = sleepShown(p.sleep);
  return (
    <div className="reader-foot-setting">
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
    </div>
  );
}
