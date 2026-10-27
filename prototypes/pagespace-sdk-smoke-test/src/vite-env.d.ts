/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PAGESPACE_TOKEN?: string;
  readonly VITE_PAGESPACE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
