// The sleep timer's stepper (#589, spec #586 "Speed and the sleep timer in the foot"; board ReaderSleep.dc.html).
// It goes Off, 5, 15, 30, 45, 60 minutes, today's choices. While the timer runs its value is the time left in whole
// minutes, rounded up, and − and + step to the neighbouring choice from there. A page module: the server imports
// none of it.

/** The minutes the timer can be set to, after Off. */
export const SLEEP_CHOICES = [5, 15, 30, 45, 60] as const;
/** The value the stepper shows for Off. */
export const SLEEP_OFF = 0;
/** The largest value the stepper shows. */
export const SLEEP_MAX = SLEEP_CHOICES[SLEEP_CHOICES.length - 1];

/** The stepper's value for the timer's seconds left (the player's `sleep`): Off, or the minutes left rounded up. */
export function sleepShown(secondsLeft: number | null | undefined): number {
  if (!secondsLeft || !Number.isFinite(secondsLeft) || secondsLeft <= 0) return SLEEP_OFF;
  return Math.min(SLEEP_MAX, Math.ceil(secondsLeft / 60));
}

/**
 * The choice one step from the value shown, as minutes to set the timer to; null is Off. − from Off stays Off and
 * + from 60 stays 60 (the stepper disables both there).
 */
export function sleepStep(shown: number, direction: -1 | 1): number | null {
  if (direction === 1) return SLEEP_CHOICES.find((minutes) => minutes > shown) ?? SLEEP_MAX;
  const lower = SLEEP_CHOICES.filter((minutes) => minutes < shown);
  return lower.length ? lower[lower.length - 1] : null;
}

/**
 * The choice for a value the Stepper part asks for (`onChange(next)`, the part counting in whole minutes from Off to
 * 60): its ends are Off and 60 (Home, End), anything else one neighbouring choice in its direction (the buttons,
 * the arrow keys, Page Up and Page Down). Undefined when nothing changes.
 */
export function sleepFromStepper(shown: number, next: number): number | null | undefined {
  if (next === shown) return undefined;
  if (next <= SLEEP_OFF) return null;
  if (next >= SLEEP_MAX) return SLEEP_MAX;
  return sleepStep(shown, next > shown ? 1 : -1);
}

/** How the stepper shows its value: "Off" or "14 min". */
export function formatSleep(shown: number): string {
  return shown <= SLEEP_OFF ? "Off" : `${shown} min`;
}
