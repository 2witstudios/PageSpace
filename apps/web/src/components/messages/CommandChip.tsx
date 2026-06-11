'use client';

import { MouseEvent, KeyboardEvent } from 'react';
import useSWR from 'swr';
import { useRouter } from 'next/navigation';
import { SlashSquare } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import {
  buildCommandChipViewModel,
  type CommandChipResolution,
} from '@/lib/commands/command-chip-model';

interface CommandChipProps {
  commandId: string;
  /** Label stored in the message serialization — survives command deletion. */
  label: string;
  /** §6: the chip sits in a conversation with no AI participant. */
  inertNoAI?: boolean;
}

interface ResolveResponse {
  results?: Record<string, CommandChipResolution>;
}

/**
 * Transcript command chip (UX spec §5): renders `/[Label](commandId:command)`
 * as an inline chip in the mention-chip visual language, resolving the
 * command's current state (deleted / disabled / revoked entry page) for the
 * VIEWER. All state→presentation logic lives in the pure view-model.
 */
export function CommandChip({ commandId, label, inertNoAI }: CommandChipProps) {
  const router = useRouter();

  const { data } = useSWR<ResolveResponse>(
    `/api/commands/resolve?ids=${encodeURIComponent(commandId)}`,
    async (url: string) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        throw new Error(`Failed to resolve command: ${response.status}`);
      }
      return response.json();
    },
    { revalidateOnFocus: false }
  );

  const resolution: CommandChipResolution = data?.results?.[commandId] ?? { state: 'loading' };
  const vm = buildCommandChipViewModel(label, resolution, { inertNoAI });

  const navigate = (e: MouseEvent | KeyboardEvent) => {
    if (!vm.navigable || !vm.href) return;
    e.preventDefault();
    router.push(vm.href);
  };

  const chip = (
    <a
      href={vm.navigable ? vm.href : undefined}
      onClick={navigate}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(e);
      }}
      tabIndex={0}
      role={vm.navigable ? undefined : 'note'}
      aria-label={vm.tooltip.join('. ')}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-sm font-medium mx-1 no-underline',
        vm.muted
          ? 'bg-muted text-muted-foreground'
          : 'bg-primary/20 text-primary dark:bg-primary/30 dark:text-primary',
        vm.navigable
          ? 'hover:bg-primary/30 dark:hover:bg-primary/40 transition-colors cursor-pointer'
          : 'cursor-default'
      )}
    >
      <SlashSquare size={13} aria-hidden="true" className="shrink-0" />
      {vm.text}
    </a>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        {vm.tooltip.map((line, index) => (
          <div key={index} className={index === 0 ? undefined : 'text-muted-foreground'}>
            {line}
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
