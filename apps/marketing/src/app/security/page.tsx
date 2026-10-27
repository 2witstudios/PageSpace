import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import {
  SecurityHero,
  SecurityKeyFeatures,
  VerifiableAuditSection,
  PermissionModelSection,
  InputSafetySection,
  SessionSecuritySection,
  WebSocketSecuritySection,
  RateLimitingSection,
  AuthenticationSection,
  SecurityCTA,
} from "@/components/sections/SecurityPageSections";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Security",
  description: "Defense-in-depth security: passkeys, magic links, OAuth PKCE, opaque session tokens with hash-only storage, per-event WebSocket authorization, distributed rate limiting, account lockout, and continuously verified audit logs.",
  path: "/security",
  keywords: ["security", "authentication", "passkeys", "OAuth", "encryption", "rate limiting", "session tokens", "audit log"],
});

export default function SecurityPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />
      <SecurityHero />
      <SecurityKeyFeatures />
      <VerifiableAuditSection />
      <PermissionModelSection />
      <InputSafetySection />
      <AuthenticationSection />
      <SessionSecuritySection />
      <WebSocketSecuritySection />
      <RateLimitingSection />
      <SecurityCTA />
      <SiteFooter />
    </div>
  );
}
