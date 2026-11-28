import type { ReactNode } from "react";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";

/** Page frame for the legal documents; embedded (the iOS app) it is the text alone. */
export function LegalPageShell({ embed, children }: { embed: boolean; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      {!embed && <SiteNavbar />}
      {children}
      {!embed && <SiteFooter />}
    </div>
  );
}
