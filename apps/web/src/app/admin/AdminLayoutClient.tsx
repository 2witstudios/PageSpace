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
  const currentTab = pathname.includes('/monitoring') ? 'monitoring' :
                     pathname.includes('/tables') ? 'tables' :
                     pathname.includes('/support') ? 'support' : 'users';

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto">
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Admin Dashboard</CardTitle>
            <CardDescription>
              Monitor system performance, manage users, view support requests, and visualize database schema
            </CardDescription>
          </CardHeader>
        </Card>

        <Tabs value={currentTab} className="w-full">
          <TabsList className="grid w-full grid-cols-4 max-w-[800px]">
            <TabsTrigger value="monitoring" asChild>
              <Link href="/admin/monitoring">Monitoring</Link>
            </TabsTrigger>
            <TabsTrigger value="tables" asChild>
              <Link href="/admin/tables">Database Tables</Link>
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