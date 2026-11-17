// Steps (spec #480, "Parts"; #490): done, running with its bar, not started; and a running step without a figure.
import { Steps } from "../../parts/Steps";
import type { GallerySection } from "../section";
import { Sample } from "../Sample";

export default {
  id: "steps",
  title: "Steps",
  order: 53,
  render: () => (
    <>
      <Sample id="steps-all" state="Done, running, not started">
        <Steps
          label="Preparing"
          steps={[
            { label: "Copying audio", state: "done" },
            { label: "Decoding audio", state: "done", value: "43 of 43 files" },
            { label: "Encoding audio", state: "running", value: "24 of 43 files", progress: 24 / 43 },
            { label: "Anchoring text to audio", state: "waiting" },
            { label: "Aligning text", state: "waiting" },
          ]}
        />
      </Sample>
      <Sample id="steps-running" state="Running, no figure">
        <Steps
          label="Saving"
          steps={[
            { label: "Aligning text", state: "done" },
            { label: "Saving the map", state: "running" },
          ]}
        />
      </Sample>
    </>
  ),
} satisfies GallerySection;
