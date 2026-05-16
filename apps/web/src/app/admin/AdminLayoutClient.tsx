"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export default function AdminLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const currentTab = pathname === '/admin' ? 'overview' :
                     pathname.includes('/global-prompt') ? 'global-prompt' : 'overview';

  return (
    <div className="min-h-screen bg-background px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Admin</CardTitle>
            <CardDescription>
              AI system prompt inspector and link to the standalone admin console
            </CardDescription>
          </CardHeader>
        </Card>

        <Tabs value={currentTab} className="w-full">
          <TabsList className="flex w-full flex-wrap gap-2 overflow-x-auto rounded-lg bg-muted/50 p-1">
            <TabsTrigger value="overview" asChild>
              <Link href="/admin">Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="global-prompt" asChild>
              <Link href="/admin/global-prompt">Global Prompt</Link>
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
