import { FAQ_INDEX, FAQ_START_HERE } from './content-basics';
import { AI_PRIVACY, REALTIME_COLLABORATION, SHARING_PERMISSIONS, TROUBLESHOOTING } from './content-other';
import { getPageTypesSeed } from './seed/page-types';
import type { SeedNodeTemplate } from './seed-types';

export function getOnboardingFaqSeedTemplate(): SeedNodeTemplate {
  return {
    title: 'FAQ',
    type: 'FOLDER',
    children: [
      { title: 'Start Here', type: 'DOCUMENT', content: FAQ_START_HERE },
      { title: 'FAQ Index', type: 'DOCUMENT', content: FAQ_INDEX },
      getPageTypesSeed(),
      {
        title: 'AI & Privacy',
        type: 'FOLDER',
        children: [{ title: 'AI & Privacy (FAQ)', type: 'DOCUMENT', content: AI_PRIVACY }],
      },
      {
        title: 'Collaboration',
        type: 'FOLDER',
        children: [
          { title: 'Sharing & Permissions', type: 'DOCUMENT', content: SHARING_PERMISSIONS },
          { title: 'Real-time Collaboration', type: 'DOCUMENT', content: REALTIME_COLLABORATION },
        ],
      },
      {
        title: 'Troubleshooting',
        type: 'FOLDER',
        children: [{ title: 'Troubleshooting (FAQ)', type: 'DOCUMENT', content: TROUBLESHOOTING }],
      },
    ],
  };
}

