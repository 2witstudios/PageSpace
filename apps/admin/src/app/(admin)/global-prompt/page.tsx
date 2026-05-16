"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { MessageSquare, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AdminGlobalPromptPage() {
  const webAppUrl = process.env.NEXT_PUBLIC_WEB_APP_URL ?? 'http://localhost:3000';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          Global Prompt Viewer
        </CardTitle>
        <CardDescription>
          The global prompt inspector is part of the main web application since it inspects the web app&apos;s AI context directly.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          View the complete system prompt and tool definitions sent to the AI from within the web app admin section.
        </p>
        <Button asChild variant="outline">
          <a href={`${webAppUrl}/admin/global-prompt`} target="_blank" rel="noopener noreferrer">
            Open in Web App <ExternalLink className="ml-2 h-4 w-4" />
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
