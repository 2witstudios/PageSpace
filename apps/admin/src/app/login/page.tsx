"use client";

import { useState, type FormEvent } from "react";
import { Shield, Loader2 } from "lucide-react";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_token: "This sign-in link is invalid. Please request a new one.",
  magic_link_expired: "This sign-in link has expired. Please request a new one.",
  magic_link_used: "This sign-in link has already been used. Please request a new one.",
  account_suspended: "This account has been suspended.",
  not_admin: "This account does not have admin access.",
  server_error: "Something went wrong. Please try again.",
};

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const params = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const errorCode = params.get("error");
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] ?? "An error occurred." : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError(null);

    try {
      const res = await fetch("/api/auth/magic-link/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        credentials: "include",
      });

      if (res.ok) {
        setStatus("sent");
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to send sign-in link.");
        setStatus("idle");
      }
    } catch {
      setError("Network error. Please try again.");
      setStatus("idle");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="rounded-full bg-primary/10 p-3">
              <Shield className="h-6 w-6 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin Console</h1>
          <p className="text-sm text-muted-foreground">
            Sign in with your admin email address
          </p>
        </div>

        {(errorMessage || error) && (
          <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
            {errorMessage ?? error}
          </div>
        )}

        {status === "sent" ? (
          <div className="rounded-md bg-muted px-4 py-6 text-center space-y-2">
            <p className="font-medium text-sm">Check your email</p>
            <p className="text-sm text-muted-foreground">
              If an admin account exists for <strong>{email}</strong>, you will
              receive a sign-in link shortly.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="admin@example.com"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <button
              type="submit"
              disabled={status === "loading" || !email}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              {status === "loading" && <Loader2 className="h-4 w-4 animate-spin" />}
              Send sign-in link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
