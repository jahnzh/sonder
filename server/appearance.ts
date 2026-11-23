import type { FastifyInstance } from "fastify";
import {
  appearanceSchema,
  defaultAppearance,
  keepPlaybackSpeed,
  keepPositionScope,
} from "../src/appearance.ts";
import { currentUserId, getUserSetting, setUserSetting } from "./users.ts";
function storedAppearance(userId: number) {
  try {
    return appearanceSchema.parse(
      JSON.parse(getUserSetting(userId, "appearance") || "{}"),
    );
  } catch {
    return defaultAppearance;
  }
}
export function registerAppearance(app: FastifyInstance) {
  app.get("/api/appearance", (req) => storedAppearance(currentUserId(req)));
  app.put("/api/appearance", (req) => {
    const userId = currentUserId(req);
    const stored = storedAppearance(userId);
    // A body without `reader.wordWpm` stores the default (300) over a saved value; this is left as it is
    // (#501 review). Since ADR 0017 the words per minute do nothing in any build: only a tab still running
    // the removed Word view could read the default back, and that view is gone once the tab reloads.
    // An older open client saves without the fields it does not know: the stored default speed and the stored
    // Reading position choice stay.
    const input = keepPositionScope(keepPlaybackSpeed(appearanceSchema.parse(req.body), stored), req.body, stored);
    setUserSetting(userId, "appearance", JSON.stringify(input));
    return input;
  });
}
