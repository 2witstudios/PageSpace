"use client";

import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";

interface AlertState {
  errorRateAlert: boolean;
  negativeMarginAlert: boolean;
  liveHoldsAlert: boolean;
}

function AlertDot() {
  return (
    <span className="ml-1.5 inline-flex h-2 w-2 rounded-full bg-red-500 align-middle" aria-hidden />
  );
}

export default function AdminLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const currentTab = pathname === '/' || pathname === '/dashboard' ? 'overview' :
                     pathname.includes('/growth') ? 'growth' :
                     pathname.includes('/monitoring') ? 'monitoring' :
                     pathname.includes('/tables') ? 'tables' :
                     pathname.includes('/global-prompt') ? 'global-prompt' :
                     pathname.includes('/unit-economics') ? 'unit-economics' :
                     pathname.includes('/ai-billing') ? 'ai-billing' :
                     pathname.includes('/audit-logs') ? 'audit-logs' :
                     pathname.includes('/support') ? 'support' : 'users';

  const [alerts, setAlerts] = useState<AlertState | null>(null);

  useEffect(() => {
    fetchWithAuth('/api/admin/alerts')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d && setAlerts(d))
      .catch(() => null);
  }, []);

  const monitoringAlert = alerts?.errorRateAlert;
  const billingAlert = alerts?.negativeMarginAlert || alerts?.liveHoldsAlert;

  return (
    <div className="min-h-screen bg-background px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Admin Console</CardTitle>
            <CardDescription>
              Monitor system performance, manage users, view support requests, visualize database schema, and inspect audit logs
            </CardDescription>
          </CardHeader>
        </Card>

        <Tabs value={currentTab} className="w-full">
          <TabsList className="flex w-full flex-wrap gap-2 overflow-x-auto rounded-lg bg-muted/50 p-1">
            <TabsTrigger value="overview" asChild>
              <Link href="/dashboard">Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="growth" asChild>
              <Link href="/growth">Growth</Link>
            </TabsTrigger>
            <TabsTrigger value="monitoring" asChild>
              <Link href="/monitoring">
                Monitoring{monitoringAlert && <AlertDot />}
              </Link>
            </TabsTrigger>
            <TabsTrigger value="tables" asChild>
              <Link href="/tables">Database Tables</Link>
            </TabsTrigger>
            <TabsTrigger value="global-prompt" asChild>
              <Link href="/global-prompt">Global Prompt</Link>
            </TabsTrigger>
            <TabsTrigger value="unit-economics" asChild>
              <Link href="/unit-economics">
                Unit Economics{billingAlert && <AlertDot />}
              </Link>
            </TabsTrigger>
            <TabsTrigger value="ai-billing" asChild>
              <Link href="/ai-billing">
                AI Billing{billingAlert && <AlertDot />}
              </Link>
            </TabsTrigger>
            <TabsTrigger value="users" asChild>
              <Link href="/users">User Management</Link>
            </TabsTrigger>
            <TabsTrigger value="audit-logs" asChild>
              <Link href="/audit-logs">Audit Logs</Link>
            </TabsTrigger>
            <TabsTrigger value="support" asChild>
              <Link href="/support">Support</Link>
            </TabsTrigger>
          </TabsList>

          <div className="mt-6">
            {children}
          </div>
        </Tabs>
      </div>
    </div>
  );
}
