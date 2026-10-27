"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import { Loader2, AlertCircle, MailCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

    const next = params.get("next") ?? undefined;

    try {
      const res = await fetch("/api/auth/magic-link/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next }),
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
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm shadow-[var(--shadow-elevated)]">
        <CardHeader className="text-center">
          <div className="mb-2 flex justify-center">
            <Image src="/pagespace-mark.png" alt="PageSpace" width={44} height={44} className="rounded-xl shadow-[var(--shadow-ambient)]" priority />
          </div>
          <CardTitle className="text-2xl tracking-tight">
            PageSpace <span className="font-normal text-muted-foreground">Admin</span>
          </CardTitle>
          <CardDescription>Sign in with your admin email address</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(errorMessage || error) && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{errorMessage ?? error}</AlertDescription>
            </Alert>
          )}

          {status === "sent" ? (
            <div className="space-y-2 rounded-md bg-muted px-4 py-6 text-center">
              <div className="flex justify-center">
                <MailCheck className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">Check your email</p>
              <p className="text-sm text-muted-foreground">
                If an admin account exists for <strong>{email}</strong>, you will
                receive a sign-in link shortly.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="admin@example.com"
                  className="h-10"
                />
              </div>
              <Button
                type="submit"
                className="h-10 w-full"
                disabled={status === "loading" || !email}
              >
                {status === "loading" && <Loader2 className="h-4 w-4 animate-spin" />}
                Send sign-in link
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
