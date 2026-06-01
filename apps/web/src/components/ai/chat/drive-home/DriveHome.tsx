'use client';

import { motion, useReducedMotion } from 'motion/react';
import { DriveMembersAvatars } from './DriveMembersAvatars';
import { JumpBackIn } from './JumpBackIn';
import { WhatsNew } from './WhatsNew';
import { AskOrDo } from './AskOrDo';

export interface DriveHomeProps {
  drive: { id: string; name: string; slug: string };
  /** Send a prompt to the assistant immediately */
  onPromptSelect: (prompt: string) => void;
  /** Place a prompt into the input for the user to complete */
  onPromptDraft: (prompt: string) => void;
  /** Open the full quick-create palette */
  onQuickCreate: () => void;
}

/**
 * DriveHome — the orienting landing surface shown in the global assistant's
 * empty state when the user is inside a drive. Answers "where am I, what's in
 * here, what's happening, what can I do" while keeping the chat input front and
 * center (it fades out the moment a conversation starts). Each section fetches
 * its own data and renders independently, so the input is never blocked.
 */
export function DriveHome({ drive, onPromptSelect, onPromptDraft, onQuickCreate }: DriveHomeProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.div
      className="flex flex-col gap-6"
      initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : 0.4, ease: [0.25, 0.1, 0.25, 1] }}
    >
      {/* Identity + collaborators */}
      <header className="flex items-center justify-between gap-4">
        <h2 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
          {drive.name}
        </h2>
        <DriveMembersAvatars driveId={drive.id} />
      </header>

      {/* Ask / do — the primary action surface, kept near the top */}
      <AskOrDo
        driveId={drive.id}
        onPromptSelect={onPromptSelect}
        onPromptDraft={onPromptDraft}
        onQuickCreate={onQuickCreate}
      />

      {/* Jump back in */}
      <JumpBackIn driveId={drive.id} />

      {/* What's new */}
      <WhatsNew driveId={drive.id} />
    </motion.div>
  );
}
