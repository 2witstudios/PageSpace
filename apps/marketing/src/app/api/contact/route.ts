import { Resend } from "resend";
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from "@pagespace/lib/security";

// Bounded-quantifier RFC 5322 regex — O(N), no ReDoS risk
const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  if (!EMAIL_PATTERN.test(email)) return false;
  return email.slice(email.lastIndexOf("@") + 1).includes(".");
}

const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@pagespace.ai";
const TO_EMAIL = process.env.CONTACT_EMAIL || "hello@pagespace.ai";

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

export async function POST(request: Request) {
  const clientIP =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  try {
    const rateLimitResult = await checkDistributedRateLimit(
      `contact:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.MARKETING_CONTACT_FORM
    );

    if (!rateLimitResult.allowed) {
      return Response.json(
        { error: "Too many contact submissions. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rateLimitResult.retryAfter || 60) } }
      );
    }

    const body = await request.json();
    const { name, email, subject, message } = body;

    // Validate fields
    if (!name || typeof name !== "string" || name.trim().length === 0 || name.length > 100) {
      return Response.json({ error: "Valid name is required (max 100 characters)" }, { status: 400 });
    }
    if (!email || typeof email !== "string" || !isValidEmail(email)) {
      return Response.json({ error: "Valid email is required" }, { status: 400 });
    }
    if (!subject || typeof subject !== "string" || subject.trim().length === 0 || subject.length > 200) {
      return Response.json({ error: "Valid subject is required (max 200 characters)" }, { status: 400 });
    }
    if (!message || typeof message !== "string" || message.trim().length < 10 || message.length > 2000) {
      return Response.json({ error: "Message must be between 10 and 2000 characters" }, { status: 400 });
    }

    await getResend().emails.send({
      from: FROM_EMAIL,
      to: TO_EMAIL,
      replyTo: email,
      subject: `[PageSpace Contact] ${subject}`,
      text: [
        `Name: ${name}`,
        `Email: ${email}`,
        `Subject: ${subject}`,
        "",
        "Message:",
        message,
        "",
        `---`,
        `IP: ${clientIP}`,
        `Sent from: pagespace.ai/contact`,
      ].join("\n"),
    });

    // Save to database via internal API (non-blocking — email delivery is the priority)
    const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
    if (INTERNAL_API_SECRET) {
      const WEB_APP_URL = process.env.WEB_APP_URL || "http://localhost:3000";
      try {
        await fetch(`${WEB_APP_URL}/api/internal/contact`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${INTERNAL_API_SECRET}`,
          },
          body: JSON.stringify({ name, email, subject, message }),
        });
      } catch (err) {
        console.error("Failed to save contact submission:", err);
      }
    }

    return Response.json(
      { message: "Message sent successfully. We'll get back to you soon!" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Contact form error:", error);
    return Response.json(
      { error: "An unexpected error occurred. Please try again later." },
      { status: 500 }
    );
  }
}
