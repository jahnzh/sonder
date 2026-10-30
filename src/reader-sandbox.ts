// WebKit can block parent listeners in a sandboxed frame unless scripts are allowed (#37).
// Probe the same kind of listener as the reader: synthetic events go through the same
// listener dispatch and sandbox check as user input, without requiring a user's gesture.
export function probeReaderSandbox(doc: Document, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let frame: HTMLIFrameElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (needsScripts: boolean) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      try { frame?.remove(); } finally { resolve(needsScripts); }
    };
    try {
      frame = doc.createElement("iframe");
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;pointer-events:none";
      frame.srcdoc = '<!doctype html><html><body><p id="reader-event-probe"></p></body></html>';
      frame.onload = () => {
        try {
          const content = frame?.contentDocument;
          const target = content?.getElementById("reader-event-probe");
          const parent = doc.defaultView;
          if (!content || !target || !parent?.PointerEvent || !parent.MouseEvent) return finish(true);
          const received = new Set<string>();
          for (const type of ["pointerdown", "pointerup", "click"]) {
            content.addEventListener(type, () => received.add(type), { once: true });
            const event = type === "click"
              ? new parent.MouseEvent(type, { bubbles: true })
              : new parent.PointerEvent(type, { bubbles: true });
            target.dispatchEvent(event);
          }
          finish(received.size !== 3);
        } catch {
          finish(true);
        }
      };
      frame.onerror = () => finish(true);
      timer = setTimeout(() => finish(true), timeoutMs);
      doc.body.appendChild(frame);
    } catch {
      finish(true);
    }
  });
}

// Safari and every browser on iOS run WebKit. A probe that wrongly says "no scripts needed" there would bring
// back the gesture bug (#37) on devices that cannot be tested here, so they always get scripts as well.
export function isWebKitEngine(agent: string, platform = "", touchPoints = 0) {
  if (/iPhone|iPad|iPod/.test(agent)) return true;
  // iPadOS reports itself as a Mac with a touch screen.
  if (platform === "MacIntel" && touchPoints > 1) return true;
  return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg|OPR|Android|Firefox/.test(agent);
}

// The probe's answer, raised to "scripts needed" for any WebKit engine.
export function scriptsRequired(
  probeSaysNeeded: boolean,
  environment?: { userAgent: string; platform?: string; maxTouchPoints?: number },
) {
  return probeSaysNeeded || (!!environment && isWebKitEngine(environment.userAgent, environment.platform, environment.maxTouchPoints));
}

let readerScripts: Promise<boolean> | undefined;

// Share the in-flight result as well as the result itself across reader instances.
export function readerNeedsScripts(): Promise<boolean> {
  return readerScripts ??= typeof document === "undefined"
    ? Promise.resolve(true)
    : probeReaderSandbox(document).then((needs) =>
        scriptsRequired(needs, typeof navigator === "undefined" ? undefined : navigator),
      );
}
