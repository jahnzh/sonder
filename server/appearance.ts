import type { FastifyInstance } from "fastify";
import { appearanceSchema, defaultAppearance } from "../src/appearance.ts";
import { getSetting } from "./services.ts";
import { db } from "./db.ts";
import { settings } from "./schema.ts";
export function registerAppearance(app: FastifyInstance) {
  app.get("/api/appearance", () => {
    try {
      return appearanceSchema.parse(
        JSON.parse(getSetting("appearance") || "{}"),
      );
    } catch {
      return defaultAppearance;
    }
  });
  app.put("/api/appearance", (req) => {
    const input = appearanceSchema.parse(req.body);
    const value = JSON.stringify(input);
    db.insert(settings)
      .values({ key: "appearance", value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
    return input;
  });
}
