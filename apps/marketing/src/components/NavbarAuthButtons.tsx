"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { APP_URL } from "@/lib/metadata";

function hasLoggedInCookie(): boolean {
  return document.cookie.split(";").some((c) => c.trim().startsWith("ps_logged_in="));
}

export function NavbarAuthButtons() {
  const [mounted, setMounted] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsLoggedIn(hasLoggedInCookie());
  }, []);

  if (!mounted) {
    // Render the default (logged-out) state during SSR to avoid layout shift
    return (
      <>
        <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
          <a href={`${APP_URL}/auth/signin`}>Log in</a>
        </Button>
        <Button size="sm" asChild>
          <a href={`${APP_URL}/auth/signup`}>Get Started</a>
        </Button>
      </>
    );
  }

  if (isLoggedIn) {
    return (
      <Button size="sm" asChild>
        <a href={`${APP_URL}/`}>Dashboard</a>
      </Button>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
        <a href={`${APP_URL}/auth/signin`}>Log in</a>
      </Button>
      <Button size="sm" asChild>
        <a href={`${APP_URL}/auth/signup`}>Get Started</a>
      </Button>
    </>
  );
}
