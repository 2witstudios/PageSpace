"use client";

import { useState } from "react";
import { PanelLeft, PanelRight, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import NotificationBell from "@/components/notifications/NotificationBell";
import VerifyEmailButton from "@/components/notifications/VerifyEmailButton";
import InlineSearch from "@/components/search/InlineSearch";
import GlobalSearch from "@/components/search/GlobalSearch";
import UserDropdown from "@/components/shared/UserDropdown";
import RecentsDropdown from "@/components/shared/RecentsDropdown";
import { AiBalanceWidget } from "@/components/billing/AiBalanceWidget";
import { VoiceNavTrigger } from "@/components/ai/voice/realtime";
import type { VoiceSurface } from "@/lib/ai/realtime/voice-binding";
import NavButtons from "./NavButtons";
import DashboardCrumb from "./DashboardCrumb";

interface TopBarProps {
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  /**
   * Bring the conversation a voice call is on into view — OPEN-ONLY, unlike
   * `onToggleRightPanel`. Owned by `Layout` because only it knows which
   * breakpoint's panel/sheet/overlay is the one to open.
   */
  onRevealAssistant: (surface: VoiceSurface) => void;
}

export default function TopBar({ onToggleLeftPanel, onToggleRightPanel, onRevealAssistant }: TopBarProps) {
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 pt-[env(safe-area-inset-top)] liquid-glass-thin border-b border-[var(--separator)] text-card-foreground shadow-[var(--shadow-ambient)] dark:shadow-none">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        {/*
          flex-wrap, not just min-w-0: this group is flex-1 and shrinkable, so
          it never forces the OUTER wrap — it silently narrows below its own
          content instead, and any child that refuses to shrink then overflows
          into the right-hand controls rather than tightening. That was
          invisible while the only occupant was a ~30px icon link; a control
          carrying a word makes it reachable. Wrapping degrades to a second row.

          This is the safety net for the breakpoint choices in DashboardCrumb,
          which rest on reading the classes of every control in this header
          rather than on measuring a running one. Get one of those wrong and
          the header gets taller, which is recoverable; without this it would
          overlap, which is not.
        */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div className="flex items-center">
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

            <NavButtons />
          </div>

          <DashboardCrumb />

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
          {/*
            THE voice trigger, in the one piece of chrome that is on every
            route. Voice is not a feature of a panel — it is a second transport
            onto whatever conversation is already in view — so its one control
            lives here and not inside the assistant sidebar it usually reveals.
          */}
          <VoiceNavTrigger onReveal={onRevealAssistant} />

          <AiBalanceWidget />

          <VerifyEmailButton />

          <NotificationBell />

          <RecentsDropdown className="lg:hidden" />

          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleRightPanel}
            className="lg:hidden"
            aria-label="Toggle assistant panel"
          >
            <PanelRight className="h-5 w-5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleRightPanel}
            className="hidden lg:flex"
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
