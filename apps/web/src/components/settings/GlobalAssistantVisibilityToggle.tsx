'use client';

/**
 * The per-environment toggle that decides whether the GLOBAL ASSISTANT may
 * reach this machine (leaf A). Default OFF — an environment with no value
 * recorded is invisible, and the absence of a value is never a grant.
 *
 * OWNER-ONLY, like every other control on a machine ([D-6]): the route decides
 * it against `drive_env_local.ownerId` and never against a drive role, so this
 * component renders read-only for anybody else rather than offering a control
 * the server will refuse.
 *
 * The copy states the guarantee and then its exact limit, in the register the
 * CLI README uses — because the limit is the part a person acts on.
 */

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { patch } from '@/lib/auth/auth-fetch';

export interface GlobalAssistantVisibilityToggleProps {
  driveId: string;
  envId: string;
  /** The machine's human label — what the confirmation names. */
  label: string;
  visible: boolean;
  /** Whether the viewer is the enrolling owner. Non-owners see the state, not a control. */
  isOwner: boolean;
  onChanged: () => void;
}

export function GlobalAssistantVisibilityToggle({ driveId, envId, label, visible, isOwner, onChanged }: GlobalAssistantVisibilityToggleProps) {
  const [saving, setSaving] = useState(false);
  const controlId = `global-assistant-visibility-${envId}`;

  const change = useCallback(
    async (next: boolean) => {
      setSaving(true);
      try {
        await patch(`/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(envId)}`, { visibleToGlobalAssistant: next });
        toast.success(
          next
            ? `Your global assistant can now see ${label} and run there when you name it`
            : `Your global assistant can no longer reach ${label}`,
        );
        onChanged();
      } catch (error) {
        toast.error('Could not change what your global assistant may reach', { description: error instanceof Error ? error.message : 'Please try again.' });
      } finally {
        setSaving(false);
      }
    },
    [driveId, envId, label, onChanged],
  );

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="space-y-1">
        <Label htmlFor={controlId} className="text-sm font-medium">
          Let your global assistant use this machine
        </Label>
        <p className="text-xs text-muted-foreground">
          {/* The guarantee, then its exact limit. */}
          Off by default. Turning it on lets the assistant you talk to from your dashboard see this machine and name it when it runs
          something — nothing more. It does not widen who may drive the machine: that is still only you, and a command or a sensitive
          write still waits for your click on this computer.
        </p>
      </div>
      {isOwner ? (
        <Switch
          id={controlId}
          checked={visible}
          disabled={saving}
          onCheckedChange={(next) => void change(next)}
          aria-label={`Let your global assistant use ${label}`}
        />
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground" data-testid={`ga-visibility-readonly-${envId}`}>
          {visible ? 'On' : 'Off'}
        </span>
      )}
    </div>
  );
}
