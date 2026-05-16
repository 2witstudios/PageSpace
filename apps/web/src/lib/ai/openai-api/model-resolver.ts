import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { PageType } from '@pagespace/lib/utils/enums';

const AGENT_MODEL_SCHEME = 'ps-agent://';

export interface ResolvedAgentPage {
  id: string;
  title: string;
  type: string;
  driveId: string | null;
  [key: string]: unknown;
}

export type AgentModelResolution =
  | { ok: true; pageId: string; page: ResolvedAgentPage }
  | { ok: false; status: number; code: string; message: string };

export const resolveAgentModel = async (
  model: string,
): Promise<AgentModelResolution> => {
  if (typeof model !== 'string' || !model.startsWith(AGENT_MODEL_SCHEME)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_model',
      message: `Model must use the ${AGENT_MODEL_SCHEME}<pageId> scheme.`,
    };
  }

  const pageId = model.slice(AGENT_MODEL_SCHEME.length).trim();
  if (!pageId) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_model',
      message: `Model must use the ${AGENT_MODEL_SCHEME}<pageId> scheme.`,
    };
  }

  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));

  if (!page || page.type !== PageType.AI_CHAT) {
    return {
      ok: false,
      status: 404,
      code: 'model_not_found',
      message: `The model '${model}' does not exist or is not an agent.`,
    };
  }

  return { ok: true, pageId, page: page as ResolvedAgentPage };
};
