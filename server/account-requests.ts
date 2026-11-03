import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlite } from "./db.ts";
import { requireAdmin } from "./users.ts";

export function registerAccountRequests(app: FastifyInstance): void {
  app.post(
    "/api/account-requests",
    { config: { rateLimit: { max: 3, timeWindow: "1 hour", keyGenerator: (request) => request.ip } } },
    async (req) => {
      // Same username rule as POST /api/users, so a request can later become a real account.
      const input = z
        .object({
          email: z.string().email(),
          username: z.string().min(2).max(40).regex(/^[a-z0-9._-]+$/i),
          note: z.string().max(1000).optional(),
          honeypot: z.string().max(200).optional(),
        })
        .parse(req.body);
      // A hidden field a person never sees; a filled one marks an automated submission.
      if (input.honeypot && input.honeypot.trim() !== "")
        throw new Error("Please check the information you entered.");
      if (input.username.toLowerCase() === "admin") throw new Error("That username is reserved.");
      sqlite
        .prepare("INSERT INTO account_requests(email,username,note,created_at) VALUES(?,?,?,?)")
        .run(input.email, input.username, input.note ?? null, Date.now());
      return { ok: true };
    },
  );
  // Same protection as GET /api/users: the handler checks the admin role, and
  // the onRequest allowlist lets an anonymous caller reach the route to be
  // answered with 401.
  app.get("/api/account-requests", (req) => {
    requireAdmin(req);
    return sqlite
      .prepare("SELECT id,email,username,note,created_at AS createdAt FROM account_requests WHERE status='pending' ORDER BY id")
      .all();
  });
}
