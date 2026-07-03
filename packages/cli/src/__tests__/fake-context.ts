import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';
import type { HandlerContext, OutputSink } from '@pagespace/cli';
import { NullCredentialStore } from '@pagespace/cli';

export function createRecordingSink(): OutputSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
    },
  };
}

export function createFakeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    sdk: new PageSpaceClient({ baseUrl: 'https://pagespace.ai', auth: new StaticTokenProvider('test-token') }),
    stdout: createRecordingSink(),
    stderr: createRecordingSink(),
    env: {},
    credentialStore: new NullCredentialStore(),
    ...overrides,
  };
}
