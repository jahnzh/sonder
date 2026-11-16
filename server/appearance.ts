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
    const input = keepPlaybackSpeed(appearanceSchema.parse(req.body), stored);
    setUserSetting(userId, "appearance", JSON.stringify(input));
    return input;
  });
}
