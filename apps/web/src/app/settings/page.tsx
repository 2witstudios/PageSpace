"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMCP } from "@/hooks/useMCP";
import { useAuth } from "@/hooks/useAuth";
import { useBillingVisibility } from "@/hooks/useBillingVisibility";
import { Button } from "@/components/ui/button";
import { User, Plug2, Key, ArrowLeft, CreditCard, Bell, Shield, ChevronRight, Keyboard, Sparkles, Calendar, Eye } from "lucide-react";

interface SettingsItem {
  title: string;
  description: string;
  icon: typeof User;
  href: string;
  available: boolean;
  desktopOnly?: boolean;
  mobileHidden?: boolean;
}

interface SettingsSection {
  title: string;
  items: SettingsItem[];
}

function SettingsRow({ item, index }: { item: SettingsItem; index: number }) {
  return (
    <div
      className={`
        flex items-center gap-4 px-4 py-3 transition-colors
        ${item.available ? "hover:bg-accent" : "opacity-50"}
        ${index > 0 ? "border-t" : ""}
      `}
    >
      <div className="flex-shrink-0">
        <item.icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium">{item.title}</div>
        <div className="text-sm text-muted-foreground truncate">
          {item.description}
        </div>
      </div>
      <div className="flex-shrink-0">
        {!item.available ? (
          <span className="text-xs text-muted-foreground">
            Coming Soon
          </span>
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const mcp = useMCP();
  const { user } = useAuth();
  const { hideBilling } = useBillingVisibility();
  const isDesktop = mcp.isDesktop;
  const isAdmin = user?.role === 'admin';

  const filterItems = (items: SettingsItem[]) => items.filter((item) => {
    if (item.desktopOnly && !isDesktop) return false;
    if (item.mobileHidden && hideBilling) return false;
    return true;
  });

  const settingsSections: SettingsSection[] = [
    {
      title: "Personal",
      items: filterItems([
        {
          title: "Account",
          description: "Manage your account and profile",
          icon: User,
          href: "/settings/account",
          available: true,
        },
        {
          title: "Personalization",
          description: "Customize how AI interacts with you",
          icon: Sparkles,
          href: "/settings/personalization",
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
          title: "Display",
          description: "Customize what UI elements are shown",
          icon: Eye,
          href: "/settings/display",
          available: true,
        },
        {
          title: "Keyboard Shortcuts",
          description: "Customize keyboard shortcuts",
          icon: Keyboard,
          href: "/settings/hotkeys",
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
      ]),
    },
    {
      title: "AI Integrations",
      items: filterItems([
        {
          title: "Google Calendar",
          description: "Import events from Google Calendar",
          icon: Calendar,
          href: "/settings/integrations/google-calendar",
          available: true,
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
      ]),
    },
    ...(isAdmin ? [{
      title: "Administration",
      items: [{
        title: "Admin",
        description: "System administration and debugging tools",
        icon: Shield,
        href: "/admin",
        available: true,
      }],
    }] : []),
  ].filter(section => section.items.length > 0);

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
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

      <div className="space-y-8">
        {settingsSections.map((section) => (
          <div key={section.title}>
            <h2 className="text-sm font-medium text-muted-foreground mb-2 px-1">
              {section.title}
            </h2>
            <div className="rounded-lg border bg-card overflow-hidden">
              {section.items.map((item, index) =>
                item.available ? (
                  <Link key={item.href} href={item.href}>
                    <SettingsRow item={item} index={index} />
                  </Link>
                ) : (
                  <div
                    key={item.href}
                    className="cursor-not-allowed"
                    aria-disabled="true"
                  >
                    <SettingsRow item={item} index={index} />
                  </div>
                )
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
