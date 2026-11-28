'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataState } from '@/components/admin/kit';
import { useAdminQuery } from '@/hooks/use-admin-query';
import { Mono } from './case-list';

interface BlockedAttempt {
  id: string;
  timestamp: string;
  userId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  entryPoint?: string;
  reason?: string;
  driveId?: string;
  pageId?: string;
  conversationId?: string;
}

/**
 * Attempts to bring blocked content back: every refusal by the upload gates,
 * from the `content.upload.blocked` audit events. Filterable by hash.
 */
export function BlockedUploads({ initialHash = '' }: { initialHash?: string }) {
  const [input, setInput] = useState(initialHash);
  const [hash, setHash] = useState(initialHash);

  const url = useMemo(() => {
    const params = new URLSearchParams({ limit: '200' });
    if (hash) params.set('hash', hash);
    return `/api/admin/content/blocked-uploads?${params}`;
  }, [hash]);
  const { data, isLoading, error, refetch } = useAdminQuery<{ attempts: BlockedAttempt[] }>(url);
  const attempts = data?.attempts ?? [];

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setHash(input.trim());
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Filter by content hash (sha256)"
          className="max-w-xl font-mono text-xs"
        />
        <Button type="submit" variant="outline">
          <Search className="mr-2 h-4 w-4" /> Filter
        </Button>
        {hash && (
          <Button type="button" variant="ghost" onClick={() => { setInput(''); setHash(''); }}>
            Clear
          </Button>
        )}
      </form>

      <DataState
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        hasData={!!data}
        isEmpty={!!data && attempts.length === 0}
        emptyMessage={hash ? 'No blocked attempts for that hash.' : 'No blocked upload attempts.'}
      >
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Content hash</TableHead>
                <TableHead>Entry point</TableHead>
                <TableHead>Where</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attempts.map((attempt) => (
                <TableRow key={attempt.id}>
                  <TableCell className="whitespace-nowrap text-xs">{new Date(attempt.timestamp).toLocaleString()}</TableCell>
                  <TableCell><Mono>{attempt.userId ?? '—'}</Mono></TableCell>
                  <TableCell className="max-w-[18rem]">
                    <Mono>{attempt.resourceId ?? '—'}</Mono>
                    {attempt.reason === 'unverifiable_file_reference' && (
                      <div className="text-xs text-muted-foreground">
                        Not a blocklist hit: a {attempt.resourceType} whose file could not be tied to a hash
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{attempt.entryPoint ?? '—'}</TableCell>
                  <TableCell className="text-xs">
                    {attempt.driveId && <div>drive <Mono>{attempt.driveId}</Mono></div>}
                    {attempt.pageId && <div>page <Mono>{attempt.pageId}</Mono></div>}
                    {attempt.conversationId && <div>conversation <Mono>{attempt.conversationId}</Mono></div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataState>
    </div>
  );
}
