// Search for a recording (#575, spec #572 "Discover"): the last row of a book search, the administrator's, at
// `#discover/get/<query>` over Discover. Until the Get sheet without a book lands (GetRecording.dc.html, `makeWork`),
// it opens the release search as the Get slice left it for a search without a book: ReleasePicker, searching the
// words at once. Close goes back to Discover with its results.
import { useState } from "react";
import { ReleasePicker } from "../components/ReleasePicker";
import { Sheet } from "../parts/Sheet";

export function RecordingSearchSheet({
  query,
  prowlarrConfigured,
  onQueued,
  refresh,
  notify,
}: {
  query: string;
  prowlarrConfigured: boolean;
  onQueued: () => void;
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [words, setWords] = useState(query);
  return (
    <Sheet title="Search for a recording" parent={{ name: "discover" }}>
      <ReleasePicker
        query={words}
        onQuery={setWords}
        prowlarrConfigured={prowlarrConfigured}
        onQueued={onQueued}
        refresh={refresh}
        notify={notify}
        searchAtOnce
      />
    </Sheet>
  );
}
