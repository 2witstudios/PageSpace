import { Resend } from "resend";

const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@pagespace.ai";
const TO_EMAIL = "hello@pagespace.ai";

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// Simple in-memory rate limiting by IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5; // 5 submissions per hour per IP

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}, 10 * 60 * 1000); // Every 10 minutes

export async function POST(request: Request) {
  const clientIP =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  try {
    if (!checkRateLimit(clientIP)) {
      return Response.json(
        { error: "Too many contact submissions. Please try again later." },
        { status: 429, headers: { "Retry-After": "3600" } }
      );
    }

    const body = await request.json();
    const { name, email, subject, message } = body;

    // Validate fields
    if (!name || typeof name !== "string" || name.trim().length === 0 || name.length > 100) {
      return Response.json({ error: "Valid name is required (max 100 characters)" }, { status: 400 });
    }
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
