"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Copy, Check, FileCode, Coins } from "lucide-react";

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

interface GlobalPromptClientProps {
  data: GlobalPromptResponse;
}

export default function GlobalPromptClient({ data }: GlobalPromptClientProps) {
  const [selectedRole, setSelectedRole] = useState<string>('PARTNER');
  const [copiedSections, setCopiedSections] = useState<Set<string>>(new Set());
  const [copiedFull, setCopiedFull] = useState(false);

  const currentRoleData = data.promptData[selectedRole];

  const handleCopySection = async (sectionName: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopiedSections(new Set(copiedSections).add(sectionName));
    setTimeout(() => {
      setCopiedSections((prev) => {
        const next = new Set(prev);
        next.delete(sectionName);
        return next;
      });
    }, 2000);
  };

  const handleCopyFull = async () => {
    await navigator.clipboard.writeText(currentRoleData.fullPrompt);
    setCopiedFull(true);
    setTimeout(() => setCopiedFull(false), 2000);
  };

  if (!currentRoleData) {
    return <div>No data available for this role</div>;
  }

  return (
    <div className="space-y-6">
      {/* Role Selector */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Agent Role</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyFull}
              className="gap-2"
            >
              {copiedFull ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy Full Prompt
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={selectedRole} onValueChange={setSelectedRole}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="PARTNER">Partner</TabsTrigger>
              <TabsTrigger value="PLANNER">Planner</TabsTrigger>
              <TabsTrigger value="WRITER">Writer</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Role Info */}
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total Tokens:</span>
              <Badge variant="secondary" className="gap-1">
                <Coins className="h-3 w-3" />
                {currentRoleData.totalTokens.toLocaleString()}
              </Badge>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Permissions:</span>
              <div className="flex gap-2">
                {currentRoleData.permissions.canRead && (
                  <Badge variant="outline">Read</Badge>
                )}
                {currentRoleData.permissions.canWrite && (
                  <Badge variant="outline">Write</Badge>
                )}
                {currentRoleData.permissions.canDelete && (
                  <Badge variant="outline">Delete</Badge>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Tools Available:</span>
              <Badge variant="secondary">
                {currentRoleData.toolsAllowed.length} / {currentRoleData.toolsAllowed.length + currentRoleData.toolsDenied.length}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Prompt Sections */}
      <Card>
        <CardHeader>
          <CardTitle>Prompt Sections</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="multiple" className="w-full">
            {currentRoleData.sections.map((section, index) => {
              const isCopied = copiedSections.has(section.name);
              return (
                <AccordionItem key={index} value={`section-${index}`}>
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center justify-between w-full pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{section.name}</span>
                        <Badge variant="secondary" className="gap-1">
                          <Coins className="h-3 w-3" />
                          {section.tokens}
                        </Badge>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-3">
                      {/* Source Info */}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <FileCode className="h-3 w-3" />
                        <code className="bg-muted px-2 py-0.5 rounded">
                          {section.source}
                          {section.lines && `:${section.lines}`}
                        </code>
                      </div>

                      {/* Content */}
                      <div className="relative">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCopySection(section.name, section.content)}
                          className="absolute top-2 right-2 z-10 gap-1"
                        >
                          {isCopied ? (
                            <>
                              <Check className="h-3 w-3" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              Copy
                            </>
                          )}
                        </Button>
                        <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs whitespace-pre-wrap font-mono">
                          {section.content}
                        </pre>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </CardContent>
      </Card>

      {/* Tools Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Tools & Permissions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="text-sm font-medium mb-2 text-green-600 dark:text-green-400">
              Allowed Tools ({currentRoleData.toolsAllowed.length})
            </h4>
            <div className="flex flex-wrap gap-2">
              {currentRoleData.toolsAllowed.map((tool) => (
                <Badge key={tool} variant="outline" className="font-mono text-xs">
                  {tool}
                </Badge>
              ))}
            </div>
          </div>

          {currentRoleData.toolsDenied.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2 text-red-600 dark:text-red-400">
                Denied Tools ({currentRoleData.toolsDenied.length})
              </h4>
              <div className="flex flex-wrap gap-2">
                {currentRoleData.toolsDenied.map((tool) => (
                  <Badge key={tool} variant="secondary" className="font-mono text-xs opacity-50">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Full Prompt Preview */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Complete System Prompt</CardTitle>
            <Badge variant="secondary" className="gap-1">
              <Coins className="h-3 w-3" />
              {currentRoleData.totalTokens.toLocaleString()} tokens
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyFull}
              className="absolute top-2 right-2 z-10 gap-1"
            >
              {copiedFull ? (
                <>
                  <Check className="h-3 w-3" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy
                </>
              )}
            </Button>
            <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs whitespace-pre-wrap font-mono max-h-96">
              {currentRoleData.fullPrompt}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Metadata */}
      <Card>
        <CardHeader>
          <CardTitle>Context Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Generated At:</span>
            <span className="font-mono">{new Date(data.metadata.generatedAt).toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Admin User ID:</span>
            <span className="font-mono text-xs">{data.metadata.adminUser.id}</span>
          </div>
          {data.metadata.locationContext?.currentDrive && (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Context Drive:</span>
                <span className="font-mono">{data.metadata.locationContext.currentDrive.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Drive ID:</span>
                <span className="font-mono text-xs">{data.metadata.locationContext.currentDrive.id}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
