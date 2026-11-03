import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { sqlite } from "./db.ts";
import { requireAdmin } from "./users.ts";
import { hashToken } from "./security.ts";
import { sendResendEmail } from "./resend.ts";

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
      // An admin alert is a courtesy, never a requirement: sendResendEmail
      // reports unconfigured and failed dispatch as not delivered instead of throwing.
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail)
        await sendResendEmail({
          to: adminEmail,
          subject: `New account request: ${input.username}`,
          text: [
            `${input.username} requested an account.`,
            `Email: ${input.email}`,
            ...(input.note ? [`Note: ${input.note}`] : []),
            "Approve or decline the request in Settings, under Users.",
          ].join("\n"),
        });
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
  const loadPendingRequest = (id: string) => {
    // A non-numeric id would make better-sqlite3 throw (a 500); answer 404.
    if (!Number.isSafeInteger(Number(id)))
      throw Object.assign(new Error("Account request not found."), { statusCode: 404 });
    const row = sqlite
      .prepare("SELECT id,email,username,status FROM account_requests WHERE id=?")
      .get(Number(id)) as { id: number; email: string; username: string; status: string } | undefined;
    if (!row)
      throw Object.assign(new Error("Account request not found."), { statusCode: 404 });
    if (row.status !== "pending")
      throw Object.assign(new Error("This request was already reviewed."), { statusCode: 409 });
    return row;
  };
  app.post("/api/account-requests/:id/decline", (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    loadPendingRequest(id);
    // No outbound email: a declined applicant hears nothing.
    sqlite
      .prepare("UPDATE account_requests SET status='declined', reviewed_at=? WHERE id=?")
      .run(Date.now(), Number(id));
    return { ok: true };
  });
  app.post("/api/account-requests/:id/approve", async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const row = loadPendingRequest(id);
    // 32 bytes of cryptographic randomness; only its hash is ever stored.
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = now + 168 * 3600000; // 7 days
    // The status guard in the UPDATE keeps the 409 airtight: if the request
    // stops being pending before this runs, the invite rolls back with it.
    sqlite.transaction(() => {
      const invite = sqlite
        .prepare(
          "INSERT INTO account_invites(token,email,username,account_request_id,created_at,expires_at) VALUES(?,?,?,?,?,?)",
        )
        .run(hashToken(token), row.email, row.username, Number(id), now, expiresAt);
      const updated = sqlite
        .prepare(
          "UPDATE account_requests SET status='approved', reviewed_at=?, invite_id=? WHERE id=? AND status='pending'",
        )
        .run(now, Number(invite.lastInsertRowid), Number(id));
      if (updated.changes === 0)
        throw Object.assign(new Error("This request was already reviewed."), { statusCode: 409 });
    })();
    // APP_URL is the address the applicant can open. It falls back to the
    // default dev/prod origin; the admin still gets the link to copy, so a
    // missing APP_URL only degrades the emailed link, never the fallback.
    const base = (process.env.APP_URL || "http://localhost:3001").replace(/\/+$/, "");
    const inviteLink = `${base}/join?token=${token}`;
    const { delivered } = await sendResendEmail({
      to: row.email,
      subject: "Your invite to join Sonder",
      text: [
        `Hi ${row.username},`,
        "",
        "An administrator approved your account request.",
        "Create your account with this link (valid for 7 days):",
        "",
        inviteLink,
      ].join("\n"),
    });
    return { ok: true, inviteLink, emailDelivered: delivered };
  });
}
