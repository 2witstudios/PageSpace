'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface WorkflowAccumulatedContextProps {
  context: Record<string, unknown>;
}

export function WorkflowAccumulatedContext({
  context,
}: WorkflowAccumulatedContextProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const { toast } = useToast();

  const handleCopy = async () => {
    try {
      const jsonString = JSON.stringify(context, null, 2);
      await navigator.clipboard.writeText(jsonString);
      setIsCopied(true);
      toast({
        title: 'Copied to clipboard',
        description: 'Context data has been copied to your clipboard.',
      });
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: 'Failed to copy context to clipboard',
        variant: 'destructive',
      });
    }
  };

  const contextEntries = Object.entries(context);
  const contextSize = contextEntries.length;

  if (contextSize === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <CardTitle className="text-base">Accumulated Context</CardTitle>
            <CardDescription>
              {contextSize} {contextSize === 1 ? 'item' : 'items'} stored in workflow context
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={handleCopy}
            >
              {isCopied ? (
                <Check className="size-4 text-green-500" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent>
          <div className="space-y-4">
            {contextEntries.map(([key, value]) => (
              <div key={key} className="space-y-2">
                <p className="text-sm font-medium">{key}</p>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto">
                  {typeof value === 'string'
                    ? value
                    : JSON.stringify(value, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
