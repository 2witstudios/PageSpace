'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { detectLanguageFromFilename } from '@pagespace/lib/utils/language-detection';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { CodeLanguageSelect } from '@/retained/components/layout/middle-content/page-views/code/CodeLanguageSelect';
import { SaveStatus, type PageTypeProps } from './shared';

const CodePageView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/code/CodePageView'), { ssr: false });

/**
 * A code page in the v3 middle (C-Files-Code): the Page tools strip with the Language select
 * and save status, then classic's editor. The language is detected from the title on every
 * load; a user's choice is not persisted yet (needs-api), so it lasts for this mount only.
 */
export function CodePage({ page, driveId, pageId }: PageTypeProps) {
  const [language, setLanguage] = useState(() => detectLanguageFromFilename(page.title));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label="Page tools">
        <CodeLanguageSelect value={language} onValueChange={setLanguage} />
        <div className="flex-1" />
        <SaveStatus pageId={page.id} />
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <CodePageView pageId={pageId} driveId={driveId} language={language} onLanguageChange={setLanguage} />
      </div>
    </div>
  );
}
