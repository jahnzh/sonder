// Stepper (spec #480, "Parts"; board Main.dc.html, the Speed row): between its ends, at its smallest and at its
// largest value, and disabled, in a Row as the board shows it.
import { useState } from "react";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import { Stepper } from "../../parts/Stepper";
import type { GallerySection, GalleryTools } from "../section";
import { Sample } from "../Sample";

const speed = (value: number) => `${value.toFixed(1)}×`;

function SpeedRow({ label, initial, disabled, act }: { label: string; initial: number; disabled?: boolean; act: GalleryTools["act"] }) {
  const [value, setValue] = useState(initial);
  return (
    <Row
      label={label}
      control={
        <Stepper
          label={label}
          value={value}
          min={0.5}
          max={3}
          step={0.1}
          format={speed}
          decreaseLabel={`Slower (${label})`}
          increaseLabel={`Faster (${label})`}
          disabled={disabled}
          onChange={(next) => {
            setValue(next);
            act(`${label} ${speed(next)}`);
          }}
        />
      }
    />
  );
}

export default {
  id: "stepper",
  title: "Stepper",
  order: 80,
  render: ({ act }) => (
    <>
      <Sample id="stepper-between" state="Between its ends">
        <Group label="Stepper between its ends">
          <SpeedRow label="Speed" initial={1.2} act={act} />
        </Group>
      </Sample>
      <Sample id="stepper-min" state="At its smallest">
        <Group label="Stepper at its smallest">
          <SpeedRow label="Slowest speed" initial={0.5} act={act} />
        </Group>
      </Sample>
      <Sample id="stepper-max" state="At its largest">
        <Group label="Stepper at its largest">
          <SpeedRow label="Fastest speed" initial={3} act={act} />
        </Group>
      </Sample>
      <Sample id="stepper-disabled" state="Disabled">
        <Group label="Stepper disabled">
          <SpeedRow label="Speed (disabled)" initial={1} disabled act={act} />
        </Group>
      </Sample>
    </>
  ),
} satisfies GallerySection;
