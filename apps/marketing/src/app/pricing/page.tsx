import Link from "next/link";
import { Check, X, Building2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata, APP_URL } from "@/lib/metadata";
import { MONTHLY_CREDITS } from "@/lib/credits";
import {
  TIERS as PLAN_ORDER,
  TIER_PLAN_LIMITS,
  formatTierBytes,
  type SubscriptionTier,
} from "@pagespace/lib/billing/subscription-tiers";

export const metadata = pageMetadata.pricing;

interface Plan {
  name: string;
  price: string;
  period?: string;
  description: string;
  cta: string;
  ctaVariant: "default" | "outline";
  highlight?: boolean;
  features: {
    storage: string;
    monthlyCredits: string;
    models: string;
    buyMore: boolean;
    realtime: boolean;
    hierarchicalAgents: boolean;
    prioritySupport: boolean;
  };
}

// Storage/credit numbers derive from the canonical TIER_PLAN_LIMITS table (the
// same table apps/web and enforcement use) so pricing copy can never drift.
const PLAN_COPY: Record<
  SubscriptionTier,
  Pick<Plan, "description" | "cta" | "ctaVariant" | "highlight"> & { models: string; prioritySupport: boolean }
> = {
  free: {
    description: "Perfect for getting started with AI-powered productivity",
    cta: "Get Started",
    ctaVariant: "outline",
    models: "Standard",
    prioritySupport: false,
  },
  pro: {
    description: "For individuals who want more AI power and storage",
    cta: "Upgrade to Pro",
    ctaVariant: "default",
    highlight: true,
    models: "Standard + Pro",
    prioritySupport: true,
  },
  founder: {
    description: "For power users and small teams who need serious AI capability",
    cta: "Upgrade to Founder",
    ctaVariant: "outline",
    models: "Standard + Pro",
    prioritySupport: true,
  },
  business: {
    description: "For teams that need maximum capacity and priority support",
    cta: "Upgrade to Business",
    ctaVariant: "outline",
    models: "Standard + Pro",
    prioritySupport: true,
  },
};

const plans: Plan[] = PLAN_ORDER.map((tier) => {
  const limits = TIER_PLAN_LIMITS[tier];
  const copy = PLAN_COPY[tier];
  return {
    name: limits.name,
    price: limits.priceMonthlyUsd === 0 ? "$0" : `$${limits.priceMonthlyUsd}`,
    period: limits.priceMonthlyUsd === 0 ? undefined : "/month",
    description: copy.description,
    cta: copy.cta,
    ctaVariant: copy.ctaVariant,
    highlight: copy.highlight,
    features: {
      storage: formatTierBytes(limits.quotaBytes, " "),
      monthlyCredits: `${MONTHLY_CREDITS[tier]}/mo`,
      models: copy.models,
      buyMore: true,
      realtime: true,
      hierarchicalAgents: true,
      prioritySupport: copy.prioritySupport,
    },
  };
});

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Simple, transparent pricing
            </h1>
            <p className="text-lg text-muted-foreground mb-4">
              Every plan includes a monthly allowance of credits that meter
              your usage. Run low? Buy more anytime. No hidden fees.
            </p>
            <p className="text-sm text-muted-foreground">
              No credit card required for the Free plan.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="pb-16 md:pb-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`rounded-2xl border p-6 flex flex-col ${
                  plan.highlight
                    ? "border-primary bg-primary/5 relative"
                    : "border-border bg-card"
                }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-primary text-primary-foreground text-xs font-medium rounded-full">
                    Most Popular
                  </div>
                )}
                <div className="mb-6">
                  <h3 className="text-xl font-semibold mb-2">{plan.name}</h3>
                  <div className="flex items-baseline gap-1 mb-2">
                    <span className="text-4xl font-bold">{plan.price}</span>
                    {plan.period && (
                      <span className="text-muted-foreground">{plan.period}</span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{plan.description}</p>
                </div>

                <div className="space-y-4 flex-1">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Storage</span>
                      <span className="font-medium">{plan.features.storage}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Credits</span>
                      <span className="font-medium">{plan.features.monthlyCredits}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Models</span>
                      <span className="font-medium">{plan.features.models}</span>
                    </div>
                  </div>

                  <div className="border-t border-border pt-4 space-y-2">
                    {[
                      { key: "buyMore", label: "Buy more credits anytime", value: plan.features.buyMore },
                      { key: "realtime", label: "Real-time collaboration", value: plan.features.realtime },
                      { key: "hierarchicalAgents", label: "Hierarchical AI agents", value: plan.features.hierarchicalAgents },
                      { key: "prioritySupport", label: "Priority support", value: plan.features.prioritySupport },
                    ].map((feature) => (
                      <div key={feature.key} className="flex items-center gap-2 text-sm">
                        {feature.value ? (
                          <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                        ) : (
                          <X className="h-4 w-4 text-muted-foreground/50 flex-shrink-0" />
                        )}
                        <span className={feature.value ? "" : "text-muted-foreground/50"}>
                          {feature.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <Button
                  className="w-full mt-6"
                  variant={plan.ctaVariant}
                  asChild
                >
                  <a href={`${APP_URL}/auth/signup`}>{plan.cta}</a>
                </Button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature Comparison Table */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <h2 className="text-2xl font-bold text-center mb-12">Full Feature Comparison</h2>

          <div className="max-w-5xl mx-auto overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left p-4 border-b border-border font-medium">Feature</th>
                  {plans.map((plan) => (
                    <th
                      key={plan.name}
                      className={`text-center p-4 border-b font-medium ${
                        plan.highlight ? "bg-primary/5 border-primary/20" : "border-border"
                      }`}
                    >
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { key: "storage", label: "Storage" },
                  { key: "monthlyCredits", label: "Monthly credits" },
                  { key: "models", label: "Model access" },
                  { key: "buyMore", label: "Buy more credits anytime" },
                  { key: "realtime", label: "Real-time Collaboration" },
                  { key: "hierarchicalAgents", label: "Hierarchical AI Agents" },
                  { key: "prioritySupport", label: "Priority Support" },
                ].map((row) => (
                  <tr key={row.key} className="hover:bg-muted/50">
                    <td className="p-4 border-b border-border">
                      {row.label}
                    </td>
                    {plans.map((plan) => {
                      const value = plan.features[row.key as keyof typeof plan.features];
                      return (
                        <td
                          key={plan.name}
                          className={`text-center p-4 border-b ${
                            plan.highlight ? "bg-primary/5 border-primary/20" : "border-border"
                          }`}
                        >
                          {typeof value === "boolean" ? (
                            value ? (
                              <Check className="h-5 w-5 text-green-500 mx-auto" />
                            ) : (
                              <X className="h-5 w-5 text-muted-foreground/30 mx-auto" />
                            )
                          ) : (
                            <span className="font-medium">{value}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Enterprise Section */}
      <section id="enterprise" className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="max-w-4xl mx-auto">
            <div className="rounded-2xl border border-border bg-card p-8 md:p-12">
              <div className="flex flex-col md:flex-row items-start md:items-center gap-8">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                      <Building2 className="h-6 w-6 text-primary" />
                    </div>
                    <h2 className="text-2xl font-bold">Enterprise</h2>
                  </div>
                  <p className="text-muted-foreground mb-4">
                    Need custom limits, SSO, advanced security, or dedicated support?
                    We&#39;ll work with you to create a plan that fits your organization.
                  </p>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-500" />
                      Custom storage and credit allowances
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-500" />
                      SSO with SAML/OIDC
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-500" />
                      Advanced admin controls
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-500" />
                      Dedicated account manager
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-500" />
                      99.9% SLA
                    </li>
                  </ul>
                </div>
                <div className="flex-shrink-0">
                  <Button size="lg" asChild>
                    <Link href="/contact">
                      Contact Sales
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Preview */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="text-2xl font-bold mb-4">Questions?</h2>
            <p className="text-muted-foreground mb-6">
              Check our FAQ for answers to common questions about pricing, billing, and features.
            </p>
            <Button variant="outline" asChild>
              <Link href="/faq">
                View FAQ
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
