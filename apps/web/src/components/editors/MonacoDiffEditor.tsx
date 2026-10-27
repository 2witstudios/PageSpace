'use client';

import { useMemo } from 'react';
import { DiffEditor, useMonaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { detectLanguageFromFilename } from '@pagespace/lib/utils/language-detection';
import { useMonacoTheme } from '@/hooks/useMonacoTheme';
import { configureMonacoLoader } from '@/lib/editor/monaco/loader-config';

interface MonacoDiffEditorProps {
  original: string;
  modified: string;
  filename?: string;
  language?: string;
  readOnly?: boolean;
  options?: editor.IDiffEditorConstructionOptions;
  className?: string;
}

configureMonacoLoader();

const MonacoDiffEditor = ({
  original,
  modified,
  filename,
  language,
  readOnly = true,
  options: optionOverrides,
  className,
}: MonacoDiffEditorProps) => {
  const monaco = useMonaco();
  const theme = useMonacoTheme(monaco);

  const resolvedLanguage = language ?? (filename ? detectLanguageFromFilename(filename) : 'plaintext');

  const defaultOptions = useMemo<editor.IDiffEditorConstructionOptions>(() => ({
    readOnly,
    originalEditable: false,
    contextmenu: true,
    selectOnLineNumbers: true,
    copyWithSyntaxHighlighting: true,
    minimap: { enabled: true },
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    fontSize: 16,
    lineNumbers: 'on',
    glyphMargin: true,
    folding: true,
    lineDecorationsWidth: 10,
    lineNumbersMinChars: 3,
    renderSideBySide: true,
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
    },
  }), [readOnly]);

  const mergedOptions = useMemo(() => ({ ...defaultOptions, ...optionOverrides }), [defaultOptions, optionOverrides]);

  return (
    <div className={className} style={{ height: '100%' }}>
      <DiffEditor
        height="100%"
        language={resolvedLanguage}
        theme={theme}
        original={original}
        modified={modified}
        options={mergedOptions}
      />
    </div>
  );
};

export default MonacoDiffEditor;
