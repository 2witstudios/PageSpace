import { WORKSPACE_TEMPLATES_GUIDE } from '../content-workspace-templates';
import type { SeedNodeTemplate } from '../seed-types';
import { buildDevTeamTemplateSeed } from './templates/dev-team';
import { buildSmallBusinessTemplateSeed } from './templates/small-business';
import { buildSoloBookWritingTemplateSeed } from './templates/solo-book-writing';
import { buildSoloFounderTemplateSeed } from './templates/solo-founder';

export function getWorkspaceTemplatesSeed(): SeedNodeTemplate {
  return {
    title: 'Workspace Templates',
    type: 'FOLDER',
    children: [
      { title: 'Workspace Templates (Guide)', type: 'DOCUMENT', content: WORKSPACE_TEMPLATES_GUIDE },
      buildSoloBookWritingTemplateSeed(),
      buildSoloFounderTemplateSeed(),
      buildSmallBusinessTemplateSeed(),
      buildDevTeamTemplateSeed(),
    ],
  };
}
