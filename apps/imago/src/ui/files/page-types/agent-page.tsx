'use client';

import { AgentSettings } from '@/retained-adapters/agent-settings';
import type { PageTypeProps } from './shared';

/** An agent page in the v3 middle (C-Files-AiChat): today its settings; Chat/History/Settings land in IMC-3.10. */
export function AgentPage({ page, driveId, pageId }: PageTypeProps) {
  return <AgentSettings pageId={pageId} driveId={driveId} title={page.title} />;
}
