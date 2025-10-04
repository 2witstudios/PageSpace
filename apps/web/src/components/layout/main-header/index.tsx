"use client";

import { useState } from "react";
import Link from "next/link";
import { Crown, Home, PanelLeft, PanelRight, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import NotificationBell from "@/components/notifications/NotificationBell";
import VerifyEmailButton from "@/components/notifications/VerifyEmailButton";
import InlineSearch from "@/components/search/InlineSearch";
import GlobalSearch from "@/components/search/GlobalSearch";
import UserDropdown from "@/components/shared/UserDropdown";
import { UsageCounter } from "@/components/billing/UsageCounter";

interface TopBarProps {
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
}

export default function TopBar({ onToggleLeftPanel, onToggleRightPanel }: TopBarProps) {
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 liquid-glass-thin border-b border-[var(--separator)] text-card-foreground shadow-[var(--shadow-ambient)] dark:shadow-none">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleLeftPanel}
            className="lg:hidden"
            aria-label="Toggle navigation"
          >
            <PanelLeft className="h-5 w-5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleLeftPanel}
            className="hidden lg:flex"
            aria-label="Collapse navigation"
          >
            <PanelLeft className="h-5 w-5" />
          </Button>

          <Link
            href="/dashboard"
            className="flex items-center text-sm text-gray-900 dark:text-gray-100"
            aria-label="Back to dashboard"
          >
            <Home className="mr-2 h-4 w-4" />
            <span>/</span>
          </Link>

          <div className="hidden min-w-[200px] flex-1 md:flex">
            <InlineSearch />
          </div>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileSearchOpen(true)}
            className="md:hidden"
            aria-label="Open search"
          >
            <Search className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <div className="hidden lg:flex">
            <UsageCounter />
          </div>

          <Button variant="ghost" size="icon" className="lg:hidden" asChild aria-label="Open billing settings">
            <Link href="/settings/billing">
              <Crown className="h-5 w-5" />
            </Link>
          </Button>

          <VerifyEmailButton />

          <NotificationBell />

          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleRightPanel}
            className="xl:hidden"
            aria-label="Toggle assistant panel"
          >
            <PanelRight className="h-5 w-5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleRightPanel}
            className="hidden xl:flex"
            aria-label="Collapse assistant panel"
          >
            <PanelRight className="h-5 w-5" />
          </Button>

          <UserDropdown />
        </div>
      </div>

      <GlobalSearch open={mobileSearchOpen} onOpenChange={setMobileSearchOpen} />
    </header>
  );
}
