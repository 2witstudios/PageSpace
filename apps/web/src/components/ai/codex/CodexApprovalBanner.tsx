'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { Terminal, FileCode, Check, X } from 'lucide-react';

export interface CodexApprovalAnnotation {
  requestId: string;
  kind: 'command' | 'fileChange';
  command?: string;
  cwd?: string;
  reason?: string;
}

interface CodexApprovalBannerProps {
  approval: CodexApprovalAnnotation;
  onResolved: (requestId: string) => void;
}

export function CodexApprovalBanner({ approval, onResolved }: CodexApprovalBannerProps) {
  const [isPending, setIsPending] = useState(false);

  async function decide(decision: 'accept' | 'decline') {
    setIsPending(true);
    try {
      const res = await fetchWithAuth(`/api/codex/approvals/${approval.requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        toast.error('Failed to send approval decision');
        return;
      }
      onResolved(approval.requestId);
    } catch {
      toast.error('Failed to send approval decision');
    } finally {
      setIsPending(false);
    }
  }

  const isCommand = approval.kind === 'command';

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 px-4 py-3 text-sm my-2">
      <div className="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400">
        {isCommand ? <Terminal className="h-4 w-4" /> : <FileCode className="h-4 w-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-amber-900 dark:text-amber-100">
          {isCommand ? 'Allow command execution?' : 'Allow file changes?'}
        </p>
        {approval.command && (
          <code className="mt-1 block text-xs font-mono text-amber-800 dark:text-amber-200 truncate">
            {approval.command}
          </code>
        )}
        {approval.cwd && (
          <p className="mt-0.5 text-xs text-amber-700/70 dark:text-amber-300/70 truncate">
            in {approval.cwd}
          </p>
        )}
        {approval.reason && (
          <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-200/80">{approval.reason}</p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => decide('decline')}
          className="h-7 px-3 text-xs border-amber-300 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/30"
        >
          <X className="h-3 w-3 mr-1" />
          Deny
        </Button>
        <Button
          size="sm"
          disabled={isPending}
          onClick={() => decide('accept')}
          className="h-7 px-3 text-xs bg-amber-600 hover:bg-amber-700 text-white"
        >
          <Check className="h-3 w-3 mr-1" />
          Allow
        </Button>
      </div>
    </div>
  );
}
