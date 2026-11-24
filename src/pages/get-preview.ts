// The preview's player in the Get audiobook sheet (#889): an audio element of its own, never the player's. It loads
// no book, writes no listening position, and sets neither Media Session metadata nor handlers, so the lock screen
// never shows it as a book; it stops when the page is hidden, so it never plays on a locked screen. The rules for
// its button, where it starts, its five-second fallback and its two-minute stop are get-preview-model.ts.
//
// The server's preview (server/torbox-preview.ts) is kept across Stop and Preview again, and ended when the sheet
// closes or another release is previewed; the server ends what is left after 30 minutes. Ending one removes nothing
// from TorBox.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib";
import type { AudiobookRelease } from "../types";
import { PREVIEW_KEEP_MS, previewTracker, type PreviewPhase } from "./get-preview-model";

type ServerPreview = { id: string; releaseId: string; madeAt: number };

const previewAudio = (id: string) => `/api/discover/previews/${encodeURIComponent(id)}/audio`;

function endOnServer(preview: ServerPreview) {
  // keepalive: the sheet's close may be the page's end.
  return api(`/discover/previews/${encodeURIComponent(preview.id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
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
  // Each start and stop takes a new token: a start's late answer finds it changed and does nothing.
  const token = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const silence = (next: PreviewPhase = "idle") => {
    token.current++;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
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
    const mine = token.current;
    const release = chosen;
    // Made in the tap itself: a browser that wants a gesture for sound (WebKit) lets this element play later.
    const element = new Audio();
    element.preload = "auto";
    element.load();
    audio.current = element;
    const failed = () => {
      if (token.current !== mine) return;
      silence("failed");
      // The failed preview is not used again: Preview of the same release asks for a new one.
      const kept = server.current;
      server.current = null;
      if (kept) void endOnServer(kept);
    };
    try {
      let kept = server.current;
      if (kept && kept.releaseId === release.id && Date.now() - kept.madeAt > PREVIEW_KEEP_MS) {
        // The server ends it by time: forgotten here, with no end sent beside the new start.
        kept = server.current = null;
      } else if (kept && kept.releaseId !== release.id) {
        // Another release previewed: the old one ends first, then the new one starts.
        server.current = null;
        await endOnServer(kept);
        kept = null;
      }
      if (token.current !== mine) return;
      if (!kept) {
        const answer = await api<{ id?: unknown }>(release.source === "prowlarr" ? "/discover/prowlarr/preview" : "/discover/abb/preview", {
          method: "POST",
          body: JSON.stringify(release.source === "prowlarr" ? { id: release.id } : { slug: release.id }),
        });
        if (typeof answer?.id !== "string") throw new Error("No preview.");
        const made = { id: answer.id, releaseId: release.id, madeAt: Date.now() };
        // A late answer to an older start: it does not replace the newer preview, and its record ends.
        if (token.current !== mine) return void endOnServer(made);
        kept = server.current = made;
      }
      const tracker = previewTracker(Date.now);
      const step = () => {
        if (token.current !== mine) return;
        const { action, played: seconds } = tracker.step(element.currentTime, element.paused);
        if (action === "stop") return stop();
        if (action === "restart") {
          element.currentTime = 0;
          void element.play().catch(failed);
        }
        setPlayed(Math.floor(seconds));
      };
      element.addEventListener(
        "loadedmetadata",
        () => {
          if (token.current !== mine) return;
          const from = tracker.started(element.duration);
          if (from) element.currentTime = from;
          void element.play().catch(failed);
          // Each second too: a stalled element sends no timeupdate, and the fallback still has to be checked.
          timer.current = setInterval(step, 1000);
        },
        { once: true },
      );
      element.addEventListener("playing", () => token.current === mine && setPhase("playing"));
      element.addEventListener("timeupdate", step);
      element.addEventListener("ended", () => token.current === mine && stop());
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
      if (server.current) void endOnServer(server.current);
      server.current = null;
    },
    [],
  );

  return { phase, played, start, stop };
}
