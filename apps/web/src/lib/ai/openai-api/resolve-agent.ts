import { PageType } from '@pagespace/lib/utils/enums';

const AGENT_MODEL_PREFIX = 'ps-agent://';

export const parseAgentModelUri = (model: string): string | null => {
  if (!model.startsWith(AGENT_MODEL_PREFIX)) return null;
  const pageId = model.slice(AGENT_MODEL_PREFIX.length);
  return pageId || null;
};

export interface AgentPage {
  id: string;
  type: string;
  title: string;
  driveId: string;
  systemPrompt: string | null;
  aiProvider: string | null;
  aiModel: string | null;
}

export type AgentResolverDeps = {
  queryPage: (pageId: string) => Promise<AgentPage | null>;
  canView: (userId: string, pageId: string) => Promise<boolean>;
};

export type AgentResult =
  | { ok: true; page: AgentPage }
  | { ok: false; status: number; error: string };

export const makeAgentResolver =
  ({ queryPage, canView }: AgentResolverDeps) =>
  async (pageId: string, userId: string): Promise<AgentResult> => {
    const page = await queryPage(pageId);

    if (!page || page.type !== PageType.AI_CHAT) {
      return { ok: false, status: 404, error: 'Agent not found' };
    }

    const allowed = await canView(userId, pageId);
    if (!allowed) {
      return { ok: false, status: 403, error: 'Access denied' };
    }

    return { ok: true, page };
  };
