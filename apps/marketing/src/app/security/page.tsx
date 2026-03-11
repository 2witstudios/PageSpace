import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import {
  SecurityHero,
  SecurityKeyFeatures,
  SessionSecuritySection,
  WebSocketSecuritySection,
  RateLimitingSection,
  AuthenticationSection,
  SecurityCTA,
} from "@/components/sections/SecurityPageSections";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Security",
  description: "Defense-in-depth security with opaque session tokens, per-event WebSocket authorization, and distributed rate limiting.",
  path: "/security",
  keywords: ["security", "authentication", "encryption", "rate limiting", "session tokens"],
});

export default function SecurityPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />
      <SecurityHero />
      <SecurityKeyFeatures />
      <SessionSecuritySection />
      <WebSocketSecuritySection />
      <RateLimitingSection />
      <AuthenticationSection />
      <SecurityCTA />
      <SiteFooter />
    </div>
  );
}
