import type { FastifyInstance } from "fastify";
import { appearanceSchema, defaultAppearance } from "../src/appearance.ts";
import { currentUserId, getUserSetting, setUserSetting } from "./users.ts";
export function registerAppearance(app: FastifyInstance) {
  app.get("/api/appearance", (req) => {
    try {
      return appearanceSchema.parse(
        JSON.parse(getUserSetting(currentUserId(req), "appearance") || "{}"),
      );
    } catch {
      return defaultAppearance;
    }
  });
  app.put("/api/appearance", (req) => {
    const input = appearanceSchema.parse(req.body);
    const value = JSON.stringify(input);
    setUserSetting(currentUserId(req), "appearance", value);
    return input;
  });
}
