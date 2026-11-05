/**
 * Substrings from real agent usage-limit UI, for terminal-tail detection tests.
 * Each entry names where the sample was taken from (repo path or documented capture).
 */

/** @type {{ agent: string, id: string, substring: string, source: string }[]} */
export const USAGE_LIMIT_TERMINAL_SAMPLES = [
  {
    agent: "codex",
    id: "codex-out-of-messages",
    substring: "You're out of Codex messages",
    source: "tests/codex-fixture.mjs REAL_EXHAUSTED.rateLimitUpsell.title (codex app-server 0.166.0, 2026-10-30)",
  },
  {
    agent: "codex",
    id: "codex-rate-limit-resets",
    substring: "Your rate limit resets on",
    source: "tests/codex-fixture.mjs REAL_EXHAUSTED.rateLimitUpsell.description (codex app-server 0.166.0, 2026-10-30)",
  },
  {
    agent: "claude",
    id: "claude-session-limit",
    substring: "You've hit your session limit",
    source:
      "Claude Code CLI blocked state (timeline detail, audiobook_streamer session 2026-10-27; same string in docs/agents/claude-usage.md /usage verification context)",
  },
  {
    agent: "claude",
    id: "claude-usage-limit-banner",
    substring: "Usage limit reached · continuing automatically",
    source: "Claude Code CLI system notice (audiobook_streamer worktree session 2026-10-28)",
  },
];

/** Agents with no in-repo terminal-tail sample yet (only quota readers / /usage panels). */
export const USAGE_LIMIT_SAMPLES_MISSING = ["cursor", "antigravity"];
