'use client';

import { useEffect, useMemo, useCallback } from 'react';
import Editor, { useMonaco, type Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useMonacoTheme } from '@/hooks/useMonacoTheme';
import { configureMonacoLoader } from '@/lib/editor/monaco/loader-config';
import { registerSudolangLanguage } from '@/lib/editor/monaco/sudolang-language';

interface MonacoEditorProps {
  value: string;
  onChange?: (value: string | undefined) => void;
  readOnly?: boolean;
  language?: string;
  options?: editor.IStandaloneEditorConstructionOptions;
  className?: string;
}

configureMonacoLoader();

const MonacoEditor = ({ value, onChange, readOnly, language = 'markdown', options: optionOverrides, className }: MonacoEditorProps) => {
  const monaco = useMonaco();
  const theme = useMonacoTheme(monaco);

  const handleBeforeMount = useCallback((monacoInstance: Monaco) => {
    registerSudolangLanguage(monacoInstance);
  }, []);

  useEffect(() => {
    if (!monaco) return;
    registerSudolangLanguage(monaco);
  }, [monaco]);

  const defaultOptions = useMemo<editor.IStandaloneEditorConstructionOptions>(() => ({
    readOnly,
    domReadOnly: readOnly,
    cursorWidth: readOnly ? 0 : undefined,
    contextmenu: true,
    columnSelection: true,
    dragAndDrop: !readOnly,
    hover: readOnly ? { enabled: true } : undefined,
    readOnlyMessage: readOnly ? { value: "" } : undefined,
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
    renderLineHighlight: readOnly ? 'none' : 'line',
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto'
    },
  }), [readOnly]);

  const mergedOptions = useMemo(() => ({ ...defaultOptions, ...optionOverrides }), [defaultOptions, optionOverrides]);

  return (
    <div className={className} style={{ height: '100%' }}>
      <Editor
        beforeMount={handleBeforeMount}
        height="100%"
        language={language}
        theme={theme}
        value={value}
        onChange={(nextValue) => {
          if (nextValue !== undefined) {
            onChange?.(nextValue);
          }
        }}
        options={mergedOptions}
      />
    </div>
  );
};

export default MonacoEditor;
