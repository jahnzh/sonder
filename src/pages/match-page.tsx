// A book's catalogue match page (#721): `#book/<workId>/match`, beside the Hardcover page until Hardcover goes.
// The administrator sees the match (AudiobookDB book or Open Library work) with Unlink, the Google Books and iTunes
// links beside it (part e), each recording's release (narrator, length, ASIN) with a picker, and a search of all four
// providers filled with the title and author: one request per provider, each group shown as it arrives with its own
// failure line. Picking a result and Match links it. Anyone else is told the administrator matches books. Words: src/catalogue-page-model.ts.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib";
import { PageHeader } from "../parts/PageHeader";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Button } from "../parts/Button";
import { ChoiceGroup } from "../parts/ChoiceRow";
import { Picker } from "../parts/Picker";
import {
  ADMIN_ONLY_LINE,
  NO_RELEASE,
  NO_RESULTS,
  NOT_MATCHED,
  PROVIDER_NAMES,
  SEARCHING,
  SEARCH_LABEL,
  SEARCH_PROVIDERS,
  choiceValue,
  currentChoices,
  linkLabel,
  outcomeLine,
  releaseLabel,
  resultDetail,
  type CatalogueProvider,
  type CatalogueSearch,
  type SearchGroup,
  type WorkCatalogue,
} from "../catalogue-page-model";
import "./settings/settings.css";
import "./hardcover-page.css";

type Props = { workId: string; admin: boolean; onChanged: () => void };
type Line = { text: string; failed: boolean } | null;

function LineText({ line }: { line: Line }) {
  if (!line) return null;
  return (
    <p className="hardcover-page-line type-label" data-failed={line.failed ? "" : undefined} role={line.failed ? "alert" : "status"}>
      {line.text}
    </p>
  );
}

export function MatchPage({ workId, admin, onChanged }: Props) {
  const [answer, setAnswer] = useState<WorkCatalogue | null>(null);
  const [line, setLine] = useState<Line>(null);
  const [busy, setBusy] = useState("");
  const [releaseFor, setReleaseFor] = useState<string | null>(null);
  useEffect(() => {
    if (!admin) return;
    let live = true;
    void api<WorkCatalogue>(`/works/${encodeURIComponent(workId)}/catalogue`)
      .then((value) => live && setAnswer(value))
      .catch((error: Error) => live && setLine({ text: error.message, failed: true }));
    return () => {
      live = false;
    };
  }, [workId, admin]);
  const act = async (name: string, path: string, method: "PUT" | "DELETE", body?: unknown) => {
    setBusy(name);
    setLine(null);
    try {
      setAnswer(await api<WorkCatalogue>(path, { method, body: JSON.stringify(body ?? {}) }));
      onChanged();
    } catch (error) {
      setLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy("");
    }
  };
  const link = answer?.link ?? null;
  const others = answer?.links ?? [];
  const outcome = answer ? outcomeLine(answer) : null;
  const picking = answer?.recordings.find((recording) => recording.recordingId === releaseFor) ?? null;
  return (
    <div className="hardcover-page" data-testid="match-page">
      <div className="hardcover-page-head">
        <PageHeader title="Match" back parent={{ name: "book", workId }} named={() => "the book"} />
        {answer && <p className="hardcover-page-book type-label">{answer.title}</p>}
      </div>
      {!admin ? (
        <p className="hardcover-page-line type-label">{ADMIN_ONLY_LINE}</p>
      ) : !answer ? (
        <LineText line={line} />
      ) : (
        <>
          <div className="hardcover-page-group">
            <Group caption="Match">
              {(link || !others.length) && <Row label={link ? PROVIDER_NAMES[link.provider] : "Catalogue"} value={link ? linkLabel(link) : NOT_MATCHED} />}
              {link?.series && <Row label="Series" value={link.series.position ? `${link.series.name} · ${link.series.position}` : link.series.name} />}
              {link && (
                <li className="part-row-item">
                  <a className="part-row hardcover-link-row" href={link.url} target="_blank" rel="noopener noreferrer">
                    <span className="part-row-label type-body">Open on {PROVIDER_NAMES[link.provider]}</span>
                  </a>
                </li>
              )}
              {link && <Row label="Unlink" disabled={!!busy} onClick={() => void act("unlink", `/works/${encodeURIComponent(workId)}/catalogue`, "DELETE")} />}
              {others.map((other) => (
                <ProviderLinkRows
                  key={other.provider}
                  other={other}
                  busy={!!busy}
                  onUnlink={() => void act("unlink", `/works/${encodeURIComponent(workId)}/catalogue?provider=${other.provider}`, "DELETE")}
                />
              ))}
            </Group>
            {outcome && (
              <p className="hardcover-page-note" data-failed={outcome.failed ? "" : undefined}>
                {outcome.text}
              </p>
            )}
          </div>
          {link?.provider === "audiobookdb" && answer.recordings.length > 0 && (
            <div className="hardcover-page-group">
              <Group caption="Releases">
                {answer.recordings.map((recording) => (
                  <Row
                    key={recording.recordingId}
                    label={recording.label}
                    value={recording.release ? releaseLabel(recording.release) : NO_RELEASE}
                    disabled={!!busy || (!answer.releases.length && !recording.release)}
                    onClick={() => setReleaseFor(recording.recordingId)}
                  />
                ))}
              </Group>
              {answer.releasesError && (
                <p className="hardcover-page-note" data-failed="">
                  {answer.releasesError}
                </p>
              )}
            </div>
          )}
          <LineText line={line} />
          <MatchSearch key={`${workId}:${currentChoices(answer).join(",")}`} answer={answer} busy={!!busy} onMatch={(provider, id, author) => void act("match", `/works/${encodeURIComponent(workId)}/catalogue`, "PUT", { provider, id, author })} />
          {picking && (
            <Picker
              open
              title="Release"
              options={[
                ...answer.releases.map((release) => ({ value: release.id, label: releaseLabel(release), detail: release.chapters ? `${release.chapters} chapters` : null })),
                { value: "", label: NO_RELEASE },
              ]}
              value={picking.release?.releaseId ?? ""}
              onClose={() => setReleaseFor(null)}
              onChoose={(value) => {
                setReleaseFor(null);
                const path = `/recordings/${encodeURIComponent(picking.recordingId)}/release`;
                void (value ? act("release", path, "PUT", { releaseId: value }) : act("release", path, "DELETE"));
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/** A Google Books or iTunes link: what it is, where it opens, and its own Unlink. */
function ProviderLinkRows({ other, busy, onUnlink }: { other: NonNullable<WorkCatalogue["links"]>[number]; busy: boolean; onUnlink: () => void }) {
  const name = PROVIDER_NAMES[other.provider];
  return (
    <>
      <Row label={name} value={linkLabel(other)} />
      <li className="part-row-item">
        <a className="part-row hardcover-link-row" href={other.url} target="_blank" rel="noopener noreferrer">
          <span className="part-row-label type-body">Open on {name}</span>
        </a>
      </li>
      <Row label={`Unlink ${name}`} disabled={busy} onClick={onUnlink} />
    </>
  );
}

/**
 * The four providers searched at once, filled with the title and author: one request each, so a group shows as soon
 * as its provider answers, with its results or its own failure line. One result is picked across all four, then Match.
 */
function MatchSearch({ answer, busy, onMatch }: { answer: WorkCatalogue; busy: boolean; onMatch: (provider: CatalogueProvider, id: string, author: string) => void }) {
  const [query, setQuery] = useState(answer.query);
  const [found, setFound] = useState<CatalogueSearch | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const asked = useRef(0);
  const search = (event?: FormEvent) => {
    event?.preventDefault();
    const text = query.trim();
    if (text.length < 2) return;
    const ask = ++asked.current;
    setFound({});
    setChosen(null);
    for (const provider of SEARCH_PROVIDERS) {
      const path = `/catalogue/search?${new URLSearchParams({ q: text.slice(0, 200), provider })}`;
      void api<CatalogueSearch>(path)
        .then((result): SearchGroup => result[provider] ?? { results: [], error: null })
        // The request itself failed (offline, the server down): that group says so; the others are not touched.
        .catch((error: Error): SearchGroup => ({ results: [], error: error.message }))
        .then((group) => {
          if (ask === asked.current) setFound((previous) => ({ ...previous, [provider]: group }));
        });
    }
  };
  // A book not matched yet is searched at once; a matched one only when asked (matching never repeats by itself).
  useEffect(() => {
    if (!answer.link && !answer.links?.length) search();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = currentChoices(answer);
  const pick = () => {
    if (!chosen || !found) return;
    const [provider, ...rest] = chosen.split(":") as [CatalogueProvider, ...string[]];
    const id = rest.join(":");
    const result = found[provider]?.results.find((entry) => entry.id === id);
    onMatch(provider, id, result?.authors.join(", ") ?? "");
  };
  return (
    <>
      <form className="hardcover-search" role="search" onSubmit={(event) => search(event)}>
        <label className="hardcover-search-field">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input type="search" className="type-body" aria-label={SEARCH_LABEL} value={query} maxLength={200} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} />
        </label>
      </form>
      {found &&
        SEARCH_PROVIDERS.map((provider) => {
          const group = found[provider];
          return (
            <div className="hardcover-match-block" key={provider} data-testid={`match-group-${provider}`}>
              <div className="part-group-caption-line hardcover-match-caption">
                <h2 className="part-group-caption type-caption">{PROVIDER_NAMES[provider]}</h2>
              </div>
              {!group ? (
                <p className="hardcover-page-line type-label" role="status">
                  {SEARCHING}
                </p>
              ) : (
                <>
                  {group.results.length > 0 && (
                    <ChoiceGroup
                      label={PROVIDER_NAMES[provider]}
                      options={group.results.map((result) => ({ value: choiceValue(provider, result.id), label: result.title, detail: resultDetail(result) || PROVIDER_NAMES[provider] }))}
                      value={chosen && chosen.startsWith(`${provider}:`) ? chosen : null}
                      onChange={(value) => setChosen(value)}
                    />
                  )}
                  {group.error ? (
                    <p className="hardcover-page-line type-label" data-failed="" role="alert">
                      {group.error}
                    </p>
                  ) : (
                    group.results.length === 0 && <p className="hardcover-page-line type-label">{NO_RESULTS}</p>
                  )}
                </>
              )}
            </div>
          );
        })}
      <Button kind="primary" className="hardcover-match-button" disabled={!chosen || busy || current.includes(chosen)} onClick={pick}>
        Match
      </Button>
    </>
  );
}
