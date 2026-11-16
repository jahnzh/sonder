import type { FastifyInstance } from "fastify";
import {
  appearanceSchema,
  defaultAppearance,
  keepPlaybackSpeed,
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
    const input = keepPlaybackSpeed(appearanceSchema.parse(req.body), stored);
    setUserSetting(userId, "appearance", JSON.stringify(input));
    return input;
  });
}
