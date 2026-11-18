// The reader's message in the foot (#591, ADR 0019, spec #586 "Messages in the foot"): the foot's lower row holds
// the message's sentence (Label, at most two lines), its quiet actions and Play or Pause at the end. Which message
// shows is `messageToShow` (src/reader-messages.ts); this file holds the state, the 8-second clock and the row.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pause, Play, X } from "lucide-react";
import { Button } from "../parts/Button";
import { claimUpdateNotice, useUpdateNotice } from "../app-update";
import {
  clearError,
  clearNotice,
  controlTapped,
  errorRetries,
  expire,
  messageText,
  noMessages,
  noticeLeavesIn,
  postError,
  postNotice,
  type ReaderError,
  type ReaderMessage,
  type ReaderMessages,
  type ReaderNotice,
} from "../reader-messages";
import "../reader-messages.css";

/** The reader's posted errors and notices, with a notice leaving by itself after its 8 seconds. */
export function useReaderMessages() {
  const [state, setState] = useState<ReaderMessages>(noMessages);
  useEffect(() => {
    const wait = noticeLeavesIn(state, Date.now());
    if (wait === null) return;
    const timer = setTimeout(() => setState((current) => expire(current, Date.now())), wait);
    return () => clearTimeout(timer);
  }, [state]);
  const error = useCallback((value: ReaderError) => setState((current) => postError(current, value, Date.now())), []);
  const notice = useCallback((value: ReaderNotice) => setState((current) => postNotice(current, value, Date.now())), []);
  const clearAnError = useCallback((which?: ReaderError) => setState((current) => clearError(current, which)), []);
  const clearANotice = useCallback((which?: ReaderNotice) => setState((current) => clearNotice(current, which)), []);
  const tapped = useCallback(
    (seen?: ReaderMessages["notice"]) => setState((current) => (current.notice ? controlTapped(current, seen) : current)),
    [],
  );
  return useMemo(
    () => ({ state, error, notice, clearError: clearAnError, clearNotice: clearANotice, tapped }),
    [state, error, notice, clearAnError, clearANotice, tapped],
  );
}

/**
 * The newer build whose notice is due, taken from the app's notice while the reader's text is on screen (the reader
 * inside Now playing stays mounted while its dialog is closed, so being mounted is not enough).
 */
export function useReaderUpdate(text: RefObject<HTMLElement | null>) {
  const update = useUpdateNotice();
  useEffect(() => {
    const element = text.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    let release: (() => void) | null = null;
    let intersecting = false;
    // A closed Now playing is only made invisible (visibility: hidden), which an intersection does not see.
    const decide = () => {
      const shown = intersecting && !element.closest('[data-state="closed"]');
      if (shown && !release) release = claimUpdateNotice();
      else if (!shown && release) {
        release();
        release = null;
      }
    };
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries[entries.length - 1]!.isIntersecting;
      decide();
    });
    observer.observe(element);
    const states = new MutationObserver(decide);
    states.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
    return () => {
      observer.disconnect();
      states.disconnect();
      release?.();
    };
  }, [text]);
  return update;
}

/** Whether a click inside the head or the foot was on a control, and not on the message's own actions. */
export function tappedControl(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;
  return !!element?.closest("button, input, select, a[href]") && !element.closest("[data-message-action]");
}

export type MessageActions = {
  undo: (notice: ReaderNotice) => void;
  retry: (error: ReaderError) => void;
  dismissError: (error: ReaderError) => void;
  stay: () => void;
  goThere: () => void;
  reload: () => void;
  dismissUpdate: (build: string) => void;
};

/** The message's row in the foot, with Play or Pause at its end while the player has a book. */
export function ReaderFootMessage({
  message,
  actions,
  play,
}: {
  message: ReaderMessage;
  actions: MessageActions;
  play: { playing: boolean; toggle: () => void } | null;
}) {
  const text = messageText(message);
  const reloading = useRef(false);
  const action = (label: string, onClick: () => void, name?: string) => (
    <Button kind="quiet" className="reader-message-action" data-message-action="" aria-label={name} onClick={onClick}>
      {label}
    </Button>
  );
  const dismiss = (onClick: () => void) => (
    <Button kind="quiet" className="reader-message-dismiss" data-message-action="" label="Dismiss" icon={<X size={20} />} onClick={onClick} />
  );
  return (
    <div className="reader-message" data-kind={message.kind}>
      <p className="reader-message-text type-label" role={message.kind === "error" ? "alert" : "status"}>
        {text}
      </p>
      {message.kind === "notice" &&
        action("Undo", () => actions.undo(message.notice), message.notice === "bookmark-removed" ? "Undo: keep the bookmark" : undefined)}
      {message.kind === "error" && (
        <>
          {errorRetries(message.error) && action("Retry", () => actions.retry(message.error))}
          {dismiss(() => actions.dismissError(message.error))}
        </>
      )}
      {message.kind === "conflict" && (
        <>
          {action("Stay", actions.stay, "Stay here")}
          {action("Go there", actions.goThere, message.chapter ? `Go to the place in ${message.chapter}` : "Go to the place saved elsewhere")}
        </>
      )}
      {message.kind === "update" && (
        <>
          {action("Reload", () => {
            if (reloading.current) return;
            reloading.current = true;
            actions.reload();
          }, "Reload Sonder")}
          {dismiss(() => actions.dismissUpdate(message.build))}
        </>
      )}
      {play && (
        <Button
          kind="quiet"
          className="reader-message-play"
          label={play.playing ? "Pause narration" : "Play narration"}
          icon={play.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          onClick={play.toggle}
        />
      )}
    </div>
  );
}
