'use client';

// A task's description is its own page's content, the HTML classic's task
// sheet edits. It is parsed into the PageSpace document schema by TipTap and
// drawn by ProseMirror: markup the schema does not know (scripts, handler
// attributes, unsafe links) never reaches the page, and nothing is set as
// raw HTML.

import { EditorContent, useEditor } from '@tiptap/react';
import { collabExtensions } from '@pagespace/editor/collab-schema';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApiClient } from '@/api/swr-provider';
import { savePageContent } from '../task-api/task-api';
import { usePageContent } from '../use-tasks/use-tasks';
import { taskDescriptionClass, taskDetailMessageClass, taskDetailNoticeClass } from '../task-detail/task-detail-class';
import { createContentSaver } from './content-saver';

type DescriptionEditorProps = { readonly pageId: string; readonly initial: string };

/** The editor, made once per task with the content it opened with. */
function DescriptionEditor({ pageId, initial }: DescriptionEditorProps): ReactNode {
  const client = useApiClient();
  const [refusal, setRefusal] = useState<string | null>(null);
  const saver = useMemo(
    () =>
      createContentSaver({
        send: (html) => savePageContent(client, pageId, html),
        onResult: (result) => setRefusal(result.ok ? null : result.refusal),
      }),
    [client, pageId],
  );
  // Leaving the task saves what was typed since the last pause.
  useEffect(
    () => () => {
      void saver.flush();
    },
    [saver],
  );
  const editor = useEditor(
    {
      extensions: collabExtensions(),
      content: initial,
      immediatelyRender: false,
      // The stylesheet TipTap would inject has no CSP nonce; the class carries what it needs.
      injectCSS: false,
      editorProps: {
        attributes: {
          class: taskDescriptionClass,
          'aria-label': 'Description',
          role: 'textbox',
          'aria-multiline': 'true',
        },
      },
      onUpdate: ({ editor: changed }) => saver.save(changed.getHTML()),
      onBlur: () => {
        void saver.flush();
      },
    },
    [saver],
  );
  return (
    <>
      <EditorContent editor={editor} />
      {refusal === null ? null : (
        <p role="status" data-description-notice="" className={taskDetailNoticeClass}>
          {refusal}
        </p>
      )}
    </>
  );
}

/** A task's description: loaded once, then edited in place and saved as typing pauses. */
export function TaskDescription({ pageId }: { readonly pageId: string }): ReactNode {
  const { content, error } = usePageContent(pageId);
  if (content === undefined) {
    return error === undefined ? (
      <p role="status" className={taskDetailMessageClass}>
        Loading description…
      </p>
    ) : (
      <p role="alert" className={taskDetailMessageClass}>
        Could not load the description.
      </p>
    );
  }
  return <DescriptionEditor key={pageId} pageId={pageId} initial={content} />;
}
