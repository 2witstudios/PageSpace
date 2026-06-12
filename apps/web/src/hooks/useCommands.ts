import { useEffect } from 'react';
import useSWR from 'swr';
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';
import { useSocket } from './useSocket';
import type { DriveEventPayload } from '@/lib/websocket';
import {
  toggleCommandInList,
  removeCommandFromList,
  type CommandItem,
} from '@/lib/commands/command-list-core';
import type {
  CreateCommandPayload,
  CommandPayloadValues,
} from '@/lib/commands/command-form-core';

interface CommandsResponse {
  commands: CommandItem[];
}

const fetcher = async (url: string): Promise<CommandsResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch commands');
  }
  return response.json();
};

const EMPTY_COMMANDS: CommandItem[] = [];

/**
 * SWR data hook over /api/commands (all commands visible to the caller:
 * personal + every member drive's). Toggle/delete apply optimistically with
 * rollback; create/update revalidate so the server-enriched fields (entry
 * page title/availability, author name) stay authoritative.
 */
export function useCommands(active: boolean = true) {
  const socket = useSocket();
  const { data, error, isLoading, mutate } = useSWR<CommandsResponse>(
    active ? '/api/commands' : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  useEffect(() => {
    if (!socket || !active) return;
    const handleDriveUpdated = (payload: DriveEventPayload) => {
      if (payload.resourceType === 'command') void mutate();
    };
    socket.on('drive:updated', handleDriveUpdated);
    return () => { socket.off('drive:updated', handleDriveUpdated); };
  }, [socket, active, mutate]);

  const commands = data?.commands ?? EMPTY_COMMANDS;

  const toggleEnabled = async (commandId: string, enabled: boolean) => {
    const optimisticData = { commands: toggleCommandInList(commands, commandId, enabled) };
    await mutate(
      async () => {
        await patch(`/api/commands/${commandId}`, { enabled });
        return optimisticData;
      },
      { optimisticData, rollbackOnError: true, revalidate: false }
    );
  };

  const createCommand = async (payload: CreateCommandPayload) => {
    await post('/api/commands', payload);
    await mutate();
  };

  const updateCommand = async (
    commandId: string,
    payload: Partial<CommandPayloadValues>
  ) => {
    await patch(`/api/commands/${commandId}`, payload);
    await mutate();
  };

  const deleteCommand = async (commandId: string) => {
    const optimisticData = { commands: removeCommandFromList(commands, commandId) };
    await mutate(
      async () => {
        await del(`/api/commands/${commandId}`);
        return optimisticData;
      },
      { optimisticData, rollbackOnError: true, revalidate: false }
    );
  };

  return {
    commands,
    isLoading,
    error,
    mutate,
    toggleEnabled,
    createCommand,
    updateCommand,
    deleteCommand,
  };
}
