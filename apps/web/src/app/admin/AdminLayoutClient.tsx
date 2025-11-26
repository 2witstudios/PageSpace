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
  const currentTab = pathname === '/admin' ? 'overview' :
                     pathname.includes('/monitoring') ? 'monitoring' :
                     pathname.includes('/tables') ? 'tables' :
                     pathname.includes('/global-prompt') ? 'global-prompt' :
                     pathname.includes('/support') ? 'support' : 'users';

  return (
    <div className="min-h-screen bg-background px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Admin Dashboard</CardTitle>
            <CardDescription>
              Monitor system performance, manage users, view support requests, visualize database schema, and inspect AI system prompts
            </CardDescription>
          </CardHeader>
        </Card>

        <Tabs value={currentTab} className="w-full">
          <TabsList className="flex w-full flex-wrap gap-2 overflow-x-auto rounded-lg bg-muted/50 p-1">
            <TabsTrigger value="overview" asChild>
              <Link href="/admin">Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="monitoring" asChild>
              <Link href="/admin/monitoring">Monitoring</Link>
            </TabsTrigger>
            <TabsTrigger value="tables" asChild>
              <Link href="/admin/tables">Database Tables</Link>
            </TabsTrigger>
            <TabsTrigger value="global-prompt" asChild>
              <Link href="/admin/global-prompt">Global Prompt</Link>
            </TabsTrigger>
            <TabsTrigger value="users" asChild>
              <Link href="/admin/users">User Management</Link>
            </TabsTrigger>
            <TabsTrigger value="support" asChild>
              <Link href="/admin/support">Support</Link>
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