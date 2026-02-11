import { loader } from '@monaco-editor/react';

type MonacoWindow = Window & {
  __NEXT_DATA__?: {
    assetPrefix?: string;
  };
};

const MONACO_VS_RELATIVE_PATH = '/_next/static/monaco/vs';

let isMonacoLoaderConfigured = false;

export const trimTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;

export const resolveAssetPrefix = (rawAssetPrefix: string, origin: string): string => {
  const normalizedAssetPrefix = rawAssetPrefix.trim();

  if (!normalizedAssetPrefix || normalizedAssetPrefix === '/') {
    return '';
  }

  if (normalizedAssetPrefix.startsWith('/')) {
    return trimTrailingSlash(normalizedAssetPrefix);
  }

  try {
    const assetPrefixUrl = new URL(normalizedAssetPrefix, origin);

    if (assetPrefixUrl.origin !== origin) {
      return '';
    }

    return trimTrailingSlash(assetPrefixUrl.pathname || '');
  } catch {
    return '';
  }
};

export const buildMonacoVsPath = (assetPrefix: string): string =>
  `${assetPrefix}${MONACO_VS_RELATIVE_PATH}`;

export const resolveMonacoVsPath = (rawAssetPrefix: string, origin: string): string => {
  const assetPrefix = resolveAssetPrefix(rawAssetPrefix, origin);
  const monacoVsPath = buildMonacoVsPath(assetPrefix);

  // Monaco can run worker bootstrapping from blob: URLs (e.g., with COI helpers).
  // In that context, absolute-path URLs like "/_next/..." cannot be resolved, so
  // we provide an absolute same-origin URL.
  return new URL(monacoVsPath, origin).toString();
};

export const getMonacoVsPath = (targetWindow: MonacoWindow): string =>
  resolveMonacoVsPath(
    targetWindow.__NEXT_DATA__?.assetPrefix ?? '',
    targetWindow.location.origin
  );

export const configureMonacoLoader = (): void => {
  if (typeof window === 'undefined' || isMonacoLoaderConfigured) {
    return;
  }

  loader.config({
    paths: {
      vs: getMonacoVsPath(window as MonacoWindow),
    },
  });

  isMonacoLoaderConfigured = true;
};
