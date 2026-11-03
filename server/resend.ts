// Outbound transactional email through Resend's HTTPS API, per
// docs/adr/0001-resend-transactional-email.md. Uses the runtime fetch so the
// server has no SMTP/socket dependency.
export type ResendMessage = {
  to: string | string[];
  subject: string;
  text: string;
};
export type ResendResult = {
  /** False when unconfigured or the call failed; never throws. */
  delivered: boolean;
};
export async function sendResendEmail(message: ResendMessage): Promise<ResendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return { delivered: false };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, ...message }),
    });
    if (!response.ok)
      console.error(`Resend dispatch rejected (HTTP ${response.status}): ${response.statusText}`);
    return { delivered: response.ok };
  } catch (error) {
    // Never throw (ADR 0001): the admin can copy the generated link instead.
    console.error(`Resend dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    return { delivered: false };
  }
}
