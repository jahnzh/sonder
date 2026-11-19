/*
 * The switch from Hardcover (#721 part d), once per database, at startup. Every user's Hardcover Want to read
 * shelf, as Sonder stored it, is copied into Sonder's own Want to read (`copyHardcoverWantToRead`, part c1: each
 * book matched to its work, the books with no work kept as that user's unmatched list). Then every stored
 * Hardcover token is deleted: each user's (`user_settings` key "hardcover") and the single-account one an early
 * build kept in `settings`. The Hardcover tables stay, unused, for one release.
 *
 * Guarded twice: a marker in `settings` stops a second run, and each user's copy runs only once anyway. The whole
 * switch is one transaction, so a failure leaves the tokens and the shelf rows as they were, writes no marker,
 * and is tried again at the next start; it never stops the server from starting.
 */
import { sqlite } from "./db.ts";
import { listUserIds } from "./users.ts";
import { copyHardcoverWantToRead } from "./want-to-read.ts";

/** The `settings` key that says the switch ran; its value is when (ms since the epoch). */
export const HARDCOVER_SWITCH_SETTING = "migration:hardcover-removed";

export type HardcoverSwitch =
  | { ran: false }
  | { ran: true; users: number; copied: number; unmatched: number; tokensDeleted: number };

export function switchFromHardcover(log: { info: (message: string) => void; warn: (message: string) => void }): HardcoverSwitch {
  try {
    return sqlite.transaction((): HardcoverSwitch => {
      if (sqlite.prepare("SELECT 1 FROM settings WHERE key=?").get(HARDCOVER_SWITCH_SETTING)) return { ran: false };
      const users = listUserIds();
      let copied = 0;
      let unmatched = 0;
      for (const userId of users) {
        const copy = copyHardcoverWantToRead(userId);
        copied += copy.ran ? copy.added.length : 0;
        unmatched += copy.ran ? copy.unmatched.length : 0;
      }
      const tokensDeleted =
        sqlite.prepare("DELETE FROM user_settings WHERE key='hardcover'").run().changes +
        sqlite.prepare("DELETE FROM settings WHERE key='hardcover'").run().changes;
      sqlite.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(HARDCOVER_SWITCH_SETTING, String(Date.now()));
      return { ran: true, users: users.length, copied, unmatched, tokensDeleted };
    })();
  } catch (error) {
    log.warn(`The switch from Hardcover did not run; it is tried again at the next start: ${error instanceof Error ? error.message : String(error)}`);
    return { ran: false };
  }
}
