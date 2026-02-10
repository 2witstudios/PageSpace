'use client';

import { useEffect, useMemo, useCallback } from 'react';
import Editor, { useMonaco, type Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useMonacoTheme } from '@/hooks/useMonacoTheme';
import { registerSudolangLanguage } from '@/lib/editor/monaco/sudolang-language';

interface MonacoEditorProps {
  value: string;
  onChange?: (value: string | undefined) => void;
  readOnly?: boolean;
  language?: string;
  options?: editor.IStandaloneEditorConstructionOptions;
  className?: string;
}

type MonacoWindow = Window & {
  __NEXT_DATA__?: {
    assetPrefix?: string;
  };
};

let isMonacoEnvironmentConfigured = false;

const WORKER_FILE_BY_LABEL: Record<string, string> = {
  json: 'json.worker.js',
  css: 'css.worker.js',
  html: 'html.worker.js',
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js',
};

const trimTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;

const getMonacoWorkerFileName = (label: string): string => {
  return WORKER_FILE_BY_LABEL[label] ?? 'editor.worker.js';
};

const getAssetPrefix = (): string => {
  if (typeof window === 'undefined') return '';

  const nextData = (window as MonacoWindow).__NEXT_DATA__;
  const rawAssetPrefix = (nextData?.assetPrefix ?? '').trim();

  if (!rawAssetPrefix || rawAssetPrefix === '/') return '';

  if (rawAssetPrefix.startsWith('/')) {
    return trimTrailingSlash(rawAssetPrefix);
  }

  try {
    const assetPrefixUrl = new URL(rawAssetPrefix, window.location.origin);

    // Keep Monaco workers same-origin so they always satisfy worker-src 'self'.
    if (assetPrefixUrl.origin !== window.location.origin) {
      return '';
    }

    return trimTrailingSlash(assetPrefixUrl.pathname || '');
  } catch {
    return '';
  }
};

const configureMonacoEnvironment = (): void => {
  if (typeof window === 'undefined' || isMonacoEnvironmentConfigured) return;

  const assetPrefix = getAssetPrefix();
  const workerBasePath = `${assetPrefix}/_next/static`;

  window.MonacoEnvironment = {
    getWorkerUrl: (_moduleId: string, label: string) =>
      `${workerBasePath}/${getMonacoWorkerFileName(label)}`,
  };
  isMonacoEnvironmentConfigured = true;
};

configureMonacoEnvironment();

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
