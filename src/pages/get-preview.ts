// The preview's player in the Get audiobook sheet (#889): an audio element of its own, never the player's. It loads
// no book, writes no listening position, and sets neither Media Session metadata nor handlers, so the lock screen
// never shows it as a book; it stops when the page is hidden, so it never plays on a locked screen. The rules for
// its button and where it starts are get-preview-model.ts.
//
// The server's preview (server/torbox-preview.ts) is kept across Stop and Preview again, so the release is not put on
// TorBox twice, and ended when the sheet closes or another release is previewed; the server ends what is left after
// 30 minutes.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib";
import type { AudiobookRelease } from "../types";
import { PREVIEW_KEEP_MS, PREVIEW_SECONDS, PREVIEW_SILENT_MS, previewStart, type PreviewPhase } from "./get-preview-model";

type ServerPreview = { id: string; releaseId: string; madeAt: number };

const previewAudio = (id: string) => `/api/discover/previews/${encodeURIComponent(id)}/audio`;

function endOnServer(preview: ServerPreview) {
  // keepalive: the sheet's close may be the page's end.
  void api(`/discover/previews/${encodeURIComponent(preview.id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

/**
 * The preview of `chosen` (a release that says "Plays now"). It stops when another row is chosen, when the page is
 * hidden, when the book starts playing (`bookPlaying`), after two minutes played, and when the sheet closes.
 */
export function usePreview(chosen: AudiobookRelease | null, bookPlaying: boolean) {
  const [phase, setPhase] = useState<PreviewPhase>("idle");
  const [played, setPlayed] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const server = useRef<ServerPreview | null>(null);
  // Each start and stop takes a new turn: a start's late answer finds it changed and does nothing.
  const turn = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const silence = (next: PreviewPhase = "idle") => {
    turn.current++;
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    const element = audio.current;
    audio.current = null;
    if (element) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    setPhase(next);
    setPlayed(0);
  };

  const stop = () => silence("idle");

  const start = async () => {
    if (!chosen?.cached || bookPlaying) return;
    silence("preparing");
    const mine = turn.current;
    const release = chosen;
    // Made in the tap itself: a browser that wants a gesture for sound (WebKit) lets this element play later.
    const element = new Audio();
    element.preload = "auto";
    element.load();
    audio.current = element;
    const failed = () => {
      if (turn.current === mine) silence("failed");
    };
    try {
      let kept = server.current;
      if (kept && (kept.releaseId !== release.id || Date.now() - kept.madeAt > PREVIEW_KEEP_MS)) {
        // Another release previewed, or one the server will soon end: the old one ends now.
        endOnServer(kept);
        kept = server.current = null;
      }
      if (!kept) {
        const answer = await api<{ id?: unknown }>(release.source === "prowlarr" ? "/discover/prowlarr/preview" : "/discover/abb/preview", {
          method: "POST",
          body: JSON.stringify(release.source === "prowlarr" ? { id: release.id } : { slug: release.id }),
        });
        if (typeof answer?.id !== "string") throw new Error("No preview.");
        kept = server.current = { id: answer.id, releaseId: release.id, madeAt: Date.now() };
      }
      if (turn.current !== mine) return;
      let last = 0;
      let total = 0;
      element.addEventListener(
        "loadedmetadata",
        () => {
          if (turn.current !== mine) return;
          const from = previewStart(element.duration);
          if (from) {
            element.currentTime = from;
            last = from;
            // Nothing sounds five seconds after the seek: from the start.
            timers.current.push(
              setTimeout(() => {
                if (turn.current === mine && (element.paused || element.currentTime < from + 0.25)) {
                  element.currentTime = 0;
                  last = 0;
                  void element.play().catch(failed);
                }
              }, PREVIEW_SILENT_MS),
            );
          }
          void element.play().catch(failed);
        },
        { once: true },
      );
      element.addEventListener("playing", () => turn.current === mine && setPhase("playing"));
      element.addEventListener("timeupdate", () => {
        if (turn.current !== mine) return;
        const step = element.currentTime - last;
        last = element.currentTime;
        if (step <= 0 || step > 2) return;
        total += step;
        if (total >= PREVIEW_SECONDS) return stop();
        setPlayed(Math.floor(total));
      });
      element.addEventListener("ended", () => turn.current === mine && stop());
      element.addEventListener("error", failed);
      element.src = previewAudio(kept.id);
      element.load();
    } catch {
      failed();
    }
  };

  // Another row chosen: the preview stops (the server's is kept until the sheet closes or another one starts).
  useEffect(() => {
    if (audio.current) stop();
    else if (phase === "failed") setPhase("idle");
  }, [chosen?.id]);
  // The book starts playing: the preview stops.
  useEffect(() => {
    if (bookPlaying && audio.current) stop();
  }, [bookPlaying]);
  // Hidden (another app, a locked screen): the preview stops.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden" && audio.current) stop();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  // The sheet closes: the preview stops and ends on the server.
  useEffect(
    () => () => {
      silence();
      if (server.current) endOnServer(server.current);
      server.current = null;
    },
    [],
  );

  return { phase, played, start, stop };
}
