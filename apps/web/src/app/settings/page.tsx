"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMCP } from "@/hooks/useMCP";
import { useAuth } from "@/hooks/useAuth";
import { useBillingVisibility } from "@/hooks/useBillingVisibility";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Settings, User, Plug2, Key, ArrowLeft, CreditCard, Bell, Shield } from "lucide-react";

interface SettingsCategory {
  title: string;
  description: string;
  icon: typeof Settings;
  href: string;
  available: boolean;
  desktopOnly?: boolean;
  mobileHidden?: boolean;
}

export default function SettingsPage() {
  const router = useRouter();
  const mcp = useMCP();
  const { user } = useAuth();
  const { hideBilling } = useBillingVisibility();
  const isDesktop = mcp.isDesktop;
  const isAdmin = user?.role === 'admin';

  const settingsCategories: SettingsCategory[] = [
    {
      title: "Account",
      description: "Manage your account and profile",
      icon: User,
      href: "/settings/account",
      available: true,
    },
    {
      title: "Notifications",
      description: "Manage email notification preferences",
      icon: Bell,
      href: "/settings/notifications",
      available: true,
    },
    {
      title: "Billing & Subscription",
      description: "Manage your subscription and billing",
      icon: CreditCard,
      href: "/settings/billing",
      available: true,
      mobileHidden: true,
    },
    {
      title: "MCP Connection",
      description: "Connect external tools to PageSpace (Cloud)",
      icon: Plug2,
      href: "/settings/mcp",
      available: true,
    },
    {
      title: "Local MCP Servers",
      description: "Run your own MCP servers (Desktop only)",
      icon: Plug2,
      href: "/settings/local-mcp",
      available: true,
      desktopOnly: true,
    },
    {
      title: "AI API Keys",
      description: "Configure AI provider API keys",
      icon: Key,
      href: "/settings/ai",
      available: true,
    },
    // Admin category (only shown to admin users)
    ...(isAdmin ? [{
      title: "Admin",
      description: "System administration and debugging tools",
      icon: Shield,
      href: "/admin",
      available: true,
    }] : []),
  ].filter((category: SettingsCategory) => {
    // Filter out desktop-only features if not on desktop
    if (category.desktopOnly && !isDesktop) {
      return false;
    }
    // Filter out billing on iOS Capacitor apps (Apple App Store compliance)
    if (category.mobileHidden && hideBilling) {
      return false;
    }
    return true;
  });

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10">
      <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/dashboard')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Button>
        <h1 className="text-3xl font-bold mb-2">Settings</h1>
        <p className="text-muted-foreground">
          Manage your application settings and preferences
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {settingsCategories.map((category) => (
          <Link 
            key={category.href}
            href={category.available ? category.href : "#"}
            className={!category.available ? "cursor-not-allowed" : ""}
          >
            <Card className={`transition-colors ${category.available ? "hover:bg-accent" : "opacity-50"}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <category.icon className="h-5 w-5" />
                  {category.title}
                  {!category.available && (
                    <span className="ml-auto text-xs text-muted-foreground font-normal">
                      Coming Soon
                    </span>
                  )}
                </CardTitle>
                <CardDescription>{category.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}