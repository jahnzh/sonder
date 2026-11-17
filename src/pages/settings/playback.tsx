// Settings › Playback (board SettingsPlayback.dc.html): Listening (Default speed, Progress bar shows), Reading
// (Reading mode, Follow the narration) and Keyboard shortcuts. Each saves when changed: the speed, the progress bar
// and the reading mode in the appearance (as the old form's Save did), Follow the narration on this device.
import { useState } from "react";
import { useAppearance } from "../../components/Appearance";
import { KeyboardHelpDialog } from "../../components/KeyboardHelp";
import { usePlayer } from "../../player";
import { SPEED_MAX, SPEED_MIN, SPEED_STEP, formatSpeed, resolveSpeed } from "../../playback-speed";
import { setFollowsNarration, useFollowsNarration } from "../../follow-default";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import { Segmented } from "../../parts/Segmented";
import { Stepper } from "../../parts/Stepper";
import { Switch } from "../../parts/Switch";
import { InfoMark } from "../../parts/Tooltip";
import { tip } from "../../tooltip-texts";
import { StackedRow } from "./StackedRow";

type Notify = (text: string, error?: boolean) => void;

/** The default speed in use: the one chosen in Settings, else the device-wide speed older builds saved, else 1. */
export function useDefaultSpeed(): number {
  const { appearance } = useAppearance();
  const { deviceSpeed } = usePlayer();
  return resolveSpeed({ preferred: appearance.playback.speed, legacy: deviceSpeed });
}

export function PlaybackPage({ notify }: { notify: Notify }) {
  const { appearance, savePlayback, saveReader } = useAppearance();
  const speed = useDefaultSpeed();
  const follows = useFollowsNarration();
  const [keys, setKeys] = useState(false);
  const failed = (error: Error) => notify(error.message, true);
  return (
    <>
      <Group caption="Listening">
        <Row
          label="Default speed"
          info={<InfoMark name="Default speed" text={tip("defaultSpeed")} />}
          control={
            <Stepper
              label="Default speed"
              value={speed}
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={SPEED_STEP}
              format={(value) => `${formatSpeed(value)}×`}
              decreaseLabel="Slower"
              increaseLabel="Faster"
              onChange={(value) => void savePlayback({ speed: value }).catch(failed)}
            />
          }
        />
        <StackedRow label="Progress bar shows" info={<InfoMark name="Progress bar shows" text={tip("progressBar")} />}>
          <Segmented
            label="Progress bar shows"
            options={[
              { value: "book", label: "Whole audiobook" },
              { value: "chapter", label: "Current chapter" },
            ]}
            value={appearance.playback.progressScope}
            onChange={(progressScope) => void savePlayback({ progressScope }).catch(failed)}
          />
        </StackedRow>
      </Group>
      <Group caption="Reading">
        <StackedRow label="Reading mode" info={<InfoMark name="Reading mode" text={tip("readingMode")} />}>
          <Segmented
            label="Reading mode"
            options={[
              { value: "paginated", label: "Pages" },
              { value: "scroll", label: "Scroll" },
            ]}
            value={appearance.reader.mode}
            onChange={(mode) => void saveReader({ mode }).catch(failed)}
          />
        </StackedRow>
        <Row
          label="Follow the narration"
          info={<InfoMark name="Follow the narration" text={tip("follow")} />}
          control={<Switch label="Follow the narration" on={follows} onChange={setFollowsNarration} />}
        />
      </Group>
      <Group label="Keyboard">
        <Row label="Keyboard shortcuts" opens onClick={() => setKeys(true)} />
      </Group>
      <KeyboardHelpDialog open={keys} onOpenChange={setKeys} />
    </>
  );
}
