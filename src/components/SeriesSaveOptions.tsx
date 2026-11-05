import { isAdmin } from "../lib";

export function SeriesSaveOptions({
  searchAudio,
  searchEbooks,
  onSearchAudio,
  onSearchEbooks,
}: {
  searchAudio: boolean;
  searchEbooks: boolean;
  onSearchAudio: (value: boolean) => void;
  onSearchEbooks: (value: boolean) => void;
}) {
  return (
    <div className="series-save-options">
      <label>
        <input
          type="checkbox"
          checked={searchAudio}
          onChange={(event) => onSearchAudio(event.target.checked)}
        />
        <span>Search for audiobooks (may download automatically)</span>
      </label>
      {isAdmin() && (
        <label>
          <input
            type="checkbox"
            checked={searchEbooks}
            onChange={(event) => onSearchEbooks(event.target.checked)}
          />
          <span>Search for ebooks (may download automatically)</span>
        </label>
      )}
    </div>
  );
}
