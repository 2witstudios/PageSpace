"use client";

import Link from "next/link";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, ExternalLink } from "lucide-react";

const ADMIN_APP_URL = process.env.NEXT_PUBLIC_ADMIN_APP_URL ?? 'http://localhost:3005';

export default function AdminPage() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Link href="/admin/global-prompt">
        <Card className="transition-colors hover:bg-accent h-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Global Prompt
            </CardTitle>
            <CardDescription>View AI system prompt and context</CardDescription>
          </CardHeader>
        </Card>
      </Link>
      <a href={ADMIN_APP_URL} target="_blank" rel="noopener noreferrer">
        <Card className="transition-colors hover:bg-accent h-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ExternalLink className="h-5 w-5" />
              Admin Console
            </CardTitle>
            <CardDescription>User management, monitoring, and system administration</CardDescription>
          </CardHeader>
        </Card>
      </a>
    </div>
  );
}
