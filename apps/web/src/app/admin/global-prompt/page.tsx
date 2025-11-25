"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSquare, AlertCircle, LayoutDashboard, FolderOpen, FileText } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth-fetch";
import GlobalPromptClient from "./GlobalPromptClient";
import type { GlobalPromptResponse } from "@/lib/ai/types/global-prompt";

export default function AdminGlobalPromptPage() {
  const [data, setData] = useState<GlobalPromptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contextType, setContextType] = useState<'dashboard' | 'drive' | 'page'>('dashboard');
  const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);

  const fetchPromptData = useCallback(async (driveId: string | null, pageId: string | null = null) => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (driveId) params.set('driveId', driveId);
      if (pageId) params.set('pageId', pageId);
      const url = params.toString()
        ? `/api/admin/global-prompt?${params.toString()}`
        : '/api/admin/global-prompt';
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        throw new Error('Failed to fetch global prompt data');
      }
      const promptData = await response.json();
      setData(promptData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchPromptData(null);
  }, [fetchPromptData]);

  // Handle context type change
  const handleContextTypeChange = (value: string) => {
    const newContextType = value as 'dashboard' | 'drive' | 'page';
    setContextType(newContextType);

    if (newContextType === 'dashboard') {
      setSelectedDriveId(null);
      setSelectedPageId(null);
      fetchPromptData(null);
    } else if (newContextType === 'drive' && data?.availableDrives?.length) {
      // Auto-select first drive when switching to drive context
      const firstDrive = data.availableDrives[0];
      setSelectedDriveId(firstDrive.id);
      setSelectedPageId(null);
      fetchPromptData(firstDrive.id);
    } else if (newContextType === 'page' && data?.availableDrives?.length) {
      // Auto-select first drive, then will need to select a page
      const firstDrive = data.availableDrives[0];
      setSelectedDriveId(firstDrive.id);
      setSelectedPageId(null);
      // Fetch with drive to get pages, then user selects a page
      fetchPromptData(firstDrive.id);
    }
  };

  // Handle drive selection change
  const handleDriveChange = (driveId: string) => {
    setSelectedDriveId(driveId);
    setSelectedPageId(null);
    if (contextType === 'page') {
      // Fetch to get pages for this drive
      fetchPromptData(driveId);
    } else {
      fetchPromptData(driveId);
    }
  };

  // Handle page selection change
  const handlePageChange = (pageId: string) => {
    setSelectedPageId(pageId);
    fetchPromptData(selectedDriveId, pageId);
  };

  if (loading && !data) {
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

  if (error && !data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Error loading global prompt data: {error}
        </AlertDescription>
      </Alert>
    );
  }

  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>No data received</AlertDescription>
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
            showing where each section is constructed from. Select a context to see how the prompt changes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Context Picker */}
          <div className="flex flex-col gap-4 p-4 bg-muted/50 rounded-lg">
            <Label className="text-sm font-medium">Context Type</Label>
            <div className="flex flex-wrap items-center gap-4">
              <Tabs
                value={contextType}
                onValueChange={handleContextTypeChange}
                className="w-auto"
              >
                <TabsList>
                  <TabsTrigger value="dashboard" className="gap-2">
                    <LayoutDashboard className="h-4 w-4" />
                    Dashboard
                  </TabsTrigger>
                  <TabsTrigger value="drive" className="gap-2">
                    <FolderOpen className="h-4 w-4" />
                    Drive
                  </TabsTrigger>
                  <TabsTrigger value="page" className="gap-2">
                    <FileText className="h-4 w-4" />
                    Page (AI Chat)
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {loading && (
                <span className="text-sm text-muted-foreground">Loading...</span>
              )}
            </div>

            {/* Drive and Page Selectors */}
            {(contextType === 'drive' || contextType === 'page') && (data.availableDrives?.length ?? 0) > 0 && (
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground">Drive:</Label>
                  <Select
                    value={selectedDriveId || ''}
                    onValueChange={handleDriveChange}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="Select a drive" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.availableDrives?.map((drive) => (
                        <SelectItem key={drive.id} value={drive.id}>
                          {drive.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {contextType === 'page' && selectedDriveId && (data.availablePages?.length ?? 0) > 0 && (
                  <div className="flex items-center gap-2">
                    <Label className="text-sm text-muted-foreground">Page:</Label>
                    <Select
                      value={selectedPageId || ''}
                      onValueChange={handlePageChange}
                    >
                      <SelectTrigger className="w-[250px]">
                        <SelectValue placeholder="Select a page" />
                      </SelectTrigger>
                      <SelectContent>
                        {data.availablePages?.map((page) => (
                          <SelectItem key={page.id} value={page.id}>
                            <span className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground uppercase">{page.type}</span>
                              {page.title}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {contextType === 'page' && selectedDriveId && (data.availablePages?.length ?? 0) === 0 && (
                  <span className="text-sm text-muted-foreground italic">No pages in this drive</span>
                )}
              </div>
            )}

            {/* Context Badge */}
            {data.metadata.contextType && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Active context:</span>
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                  data.metadata.contextType === 'page'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
                    : data.metadata.contextType === 'drive'
                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100'
                    : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100'
                }`}>
                  {data.metadata.contextType === 'page' && '📄 Page Context (same as AI Chat)'}
                  {data.metadata.contextType === 'drive' && '📁 Drive Context'}
                  {data.metadata.contextType === 'dashboard' && '🏠 Dashboard Context'}
                </span>
              </div>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
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
                {data.toolSchemas?.length || Object.values(data.promptData)[0]?.toolsAllowed.length || 0}
              </div>
              <div className="text-muted-foreground">Total Tools</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {data.totalToolTokens?.toLocaleString() || '—'}
              </div>
              <div className="text-muted-foreground">Tool Tokens</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary truncate max-w-[150px]" title={
                data.metadata.locationContext?.currentPage?.title ||
                data.metadata.locationContext?.currentDrive?.name ||
                'Dashboard'
              }>
                {data.metadata.locationContext?.currentPage?.title ||
                 data.metadata.locationContext?.currentDrive?.name ||
                 'Dashboard'}
              </div>
              <div className="text-muted-foreground">
                {data.metadata.locationContext?.currentPage ? 'Page' :
                 data.metadata.locationContext?.currentDrive ? 'Drive' : 'Context'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <GlobalPromptClient data={data} />
    </div>
  );
}
