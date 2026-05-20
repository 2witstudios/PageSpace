"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function AdminLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const currentTab = pathname === '/' || pathname === '/dashboard' ? 'overview' :
                     pathname.includes('/monitoring') ? 'monitoring' :
                     pathname.includes('/tables') ? 'tables' :
                     pathname.includes('/global-prompt') ? 'global-prompt' :
                     pathname.includes('/audit-logs') ? 'audit-logs' :
                     pathname.includes('/support') ? 'support' : 'users';

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
            <TabsTrigger value="monitoring" asChild>
              <Link href="/monitoring">Monitoring</Link>
            </TabsTrigger>
            <TabsTrigger value="tables" asChild>
              <Link href="/tables">Database Tables</Link>
            </TabsTrigger>
            <TabsTrigger value="global-prompt" asChild>
              <Link href="/global-prompt">Global Prompt</Link>
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