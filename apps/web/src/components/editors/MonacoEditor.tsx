import { useMemo } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useMonacoTheme } from '@/hooks/useMonacoTheme';

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

const getMonacoWorkerFileName = (label: string): string => {
  if (label === 'json') return 'json.worker.js';
  if (label === 'css') return 'css.worker.js';
  if (label === 'html') return 'html.worker.js';
  if (label === 'typescript' || label === 'javascript') return 'ts.worker.js';
  return 'editor.worker.js';
};

const getAssetPrefix = (): string => {
  if (typeof window === 'undefined') return '';

  const nextData = (window as MonacoWindow).__NEXT_DATA__;
  const rawAssetPrefix = nextData?.assetPrefix ?? '';

  if (!rawAssetPrefix || rawAssetPrefix === '/') return '';
  return rawAssetPrefix.endsWith('/')
    ? rawAssetPrefix.slice(0, -1)
    : rawAssetPrefix;
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

  configureMonacoEnvironment();

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
        height="100%"
        language={language}
        theme={theme}
        value={value}
        onChange={onChange}
        options={mergedOptions}
      />
    </div>
  );
};

export default MonacoEditor;
