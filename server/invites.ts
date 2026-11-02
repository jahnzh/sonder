import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { createUser, passwordSchema } from "./users.ts";
import { hashToken } from "./security.ts";

type Invite = {
  id: number;
  email: string;
  username: string;
  expires_at: number;
  claimed_at: number | null;
};

// Status codes a raw invite token can have. 404 answers a token that was never
// issued and one that has already been used — the messages stay distinct, so
// the applicant hears which is the case. 410 marks an invite past its expiry.
const notValid = () => Object.assign(new Error("This invite link is not valid."), { statusCode: 404 });
const alreadyUsed = () => Object.assign(new Error("This invite link has already been used."), { statusCode: 404 });
const expired = () => Object.assign(new Error("This invite link has expired."), { statusCode: 410 });

// Look up by hash only: the raw token exists in the URL and is never stored.
function findInvite(token: string): Invite | undefined {
  return sqlite
    .prepare("SELECT id,email,username,expires_at,claimed_at FROM account_invites WHERE token=?")
    .get(hashToken(token)) as Invite | undefined;
}
function usableInvite(token: string): Invite {
  const invite = findInvite(token);
  if (!invite) throw notValid();
  if (invite.claimed_at !== null) throw alreadyUsed();
  if (invite.expires_at <= Date.now()) throw expired();
  return invite;
}

export function registerInvites(app: FastifyInstance): void {
  app.get("/api/invites/verify", (req) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.query);
    const invite = usableInvite(token);
    return { ok: true, username: invite.username, email: invite.email };
  });
  // Same per-IP limit as POST /api/auth/login: the token is unguessable, but a
  // claim also hashes a password, so a flood must not buy CPU.
  app.post(
    "/api/invites/claim",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes", keyGenerator: (request) => request.ip } } },
    async (req, reply) => {
      const { token, password } = z
        .object({ token: z.string().min(1), password: passwordSchema })
        .parse(req.body);
      const invite = usableInvite(token);
      const now = Date.now();
      // Claiming marks the invite and creates the user in one transaction: if
      // the username is taken, or a second request wins the claim race, the
      // mark rolls back and the invite stays usable (or the account is not
      // duplicated).
      const id = sqlite.transaction(() => {
        const marked = sqlite
          .prepare("UPDATE account_invites SET claimed_at=? WHERE id=? AND claimed_at IS NULL")
          .run(now, invite.id);
        if (marked.changes === 0) throw alreadyUsed();
        let userId: number;
        try {
          userId = createUser(invite.username, password);
        } catch (error) {
          if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
            throw Object.assign(new Error("That username is already taken."), { statusCode: 409 });
          throw error;
        }
        return userId;
      })();
      const user = sqlite
        .prepare("SELECT id,username,role,created_at AS createdAt FROM users WHERE id=?")
        .get(id) as { id: number; username: string; role: "admin" | "user"; createdAt: number };
      // The session mirrors POST /api/auth/login: 32 random bytes, only the
      // hash stored, 30 days, http-only.
      const session = randomBytes(32).toString("hex");
      sqlite.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
      db.insert(s.sessions)
        .values({ token: hashToken(session), userId: id, expiresAt: now + 30 * 86400000 })
        .run();
      return reply
        .setCookie("sonder_session", session, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
          secure: process.env.COOKIE_SECURE === "true",
          maxAge: 30 * 86400,
        })
        .send({ ok: true, user });
    },
  );
}
