// Real viewport sizes on the Android emulator (issue #66). Neither browser emulates a viewport
// there: Playwright skips viewport emulation for Chrome on Android, and Firefox for Android does
// not implement browsingContext.setViewport. The screen itself is resized with `wm size` so the
// page's CSS viewport is the requested size, with the browser's own toolbars still on screen.

export type Size = { width: number; height: number };

// The physical screen size for a CSS viewport, given the device pixel ratio and the CSS pixels the
// system bars and browser toolbar take from the screen's height.
export function screenSizeFor(viewport: Size, devicePixelRatio: number, chromeHeight: number): Size {
  return {
    width: Math.round(viewport.width * devicePixelRatio),
    height: Math.round((viewport.height + chromeHeight) * devicePixelRatio),
  };
}
