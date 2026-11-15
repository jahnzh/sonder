/**
 * The player's play requests. Every load is one: a newer request makes an older load give up at its next await,
 * so the newest choice of book, chapter or place wins.
 *
 * A load waits for the saved progress, the delivery plan and sometimes a device copy before it moves the audio.
 * The listener's pause during that wait (the play/pause button, Space, the lock screen) is not a new choice of
 * place: the load still goes where it was asked to go and lands paused. Before #419 the pause was counted as a
 * newer request, so an Undo of "Listen from here" followed by a quick pause lost the Undo's move back.
 */
export type PlayLoad = {
  readonly request: number;
  /** No newer request was made since this load started. */
  current: () => boolean;
  /** Whether the load starts playback when it lands; a pause while it waits turns this off. */
  autoplay: () => boolean;
  /** The load reached its play or pause: from now on a pause is the element's own, and cancels nothing. */
  landed: () => void;
};

export type PlayRequests = {
  /** The number of the newest request. */
  readonly current: number;
  /** A new load, which supersedes every earlier one. */
  start: (autoplay: boolean) => PlayLoad;
  /** The listener paused: a load still waiting lands paused; otherwise this is a newer request, as before. */
  pause: () => void;
  /** The listener played again while a load they paused still waits: it lands playing. True when that happened. */
  resume: () => boolean;
  /** Stops any load in flight (media removed, device reset). */
  cancel: () => void;
};

export function playRequests(): PlayRequests {
  let current = 0;
  let waiting: { request: number; autoplay: boolean; paused: boolean } | null = null;
  const live = () => (waiting && waiting.request === current ? waiting : null);
  return {
    get current() {
      return current;
    },
    start(autoplay) {
      const load = { request: ++current, autoplay, paused: false };
      waiting = load;
      return {
        request: load.request,
        current: () => load.request === current,
        autoplay: () => load.autoplay,
        landed: () => {
          if (waiting === load) waiting = null;
        },
      };
    },
    pause() {
      const load = live();
      if (!load) {
        current++;
        return;
      }
      if (load.autoplay) load.paused = true;
      load.autoplay = false;
    },
    resume() {
      const load = live();
      if (!load?.paused) return false;
      load.paused = false;
      load.autoplay = true;
      return true;
    },
    cancel() {
      current++;
    },
  };
}
