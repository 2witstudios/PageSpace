"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MessageSquare, AlertCircle } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth-fetch";
import GlobalPromptClient from "./GlobalPromptClient";

interface PromptSection {
  name: string;
  content: string;
  source: string;
  lines?: string;
  tokens: number;
}

interface RolePromptData {
  role: string;
  fullPrompt: string;
  sections: PromptSection[];
  totalTokens: number;
  toolsAllowed: string[];
  toolsDenied: string[];
  permissions: {
    canRead: boolean;
    canWrite: boolean;
    canDelete: boolean;
    requiresConfirmation: boolean;
  };
}

interface GlobalPromptResponse {
  promptData: Record<string, RolePromptData>;
  metadata: {
    generatedAt: string;
    adminUser: {
      id: string;
      role: 'user' | 'admin';
    };
    locationContext?: {
      currentDrive?: {
        id: string;
        name: string;
        slug: string;
      };
    };
  };
}

export default function AdminGlobalPromptPage() {
  const [data, setData] = useState<GlobalPromptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchPromptData() {
      try {
        const response = await fetchWithAuth('/api/admin/global-prompt');
        if (!response.ok) {
          throw new Error('Failed to fetch global prompt data');
        }
        const promptData = await response.json();
        setData(promptData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    }

    fetchPromptData();
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
        </Card>

        {[...Array(3)].map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Error loading global prompt data: {error || 'No data received'}
        </AlertDescription>
      </Alert>
    );
  }

  const roles = Object.keys(data.promptData);
  const totalSections = Object.values(data.promptData).reduce(
    (sum, role) => sum + role.sections.length,
    0
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <MessageSquare className="h-5 w-5" />
            <span>Global Assistant System Prompt</span>
          </CardTitle>
          <CardDescription>
            View the complete system prompt sent to the Global Assistant with detailed annotations
            showing where each section is constructed from. This shows the actual prompt used for
            conversations in your current context.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{roles.length}</div>
              <div className="text-muted-foreground">Agent Roles</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{totalSections}</div>
              <div className="text-muted-foreground">Prompt Sections</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {Object.values(data.promptData)[0]?.toolsAllowed.length || 0}
              </div>
              <div className="text-muted-foreground">Total Tools</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {data.metadata.locationContext?.currentDrive ? 'Drive' : 'Dashboard'}
              </div>
              <div className="text-muted-foreground">Context</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <GlobalPromptClient data={data} />
    </div>
  );
}
