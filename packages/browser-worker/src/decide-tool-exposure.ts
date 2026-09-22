import type { BrowserToolName } from './browser-tool-name.js';

export type DecideToolExposureOptions = {
  /** A substrate and the control signing key are configured on this server. */
  readonly substrateConfigured: boolean;
  /** The platform-wide code-execution kill switch. */
  readonly codeExecutionEnabled: boolean;
  readonly agent: {
    readonly sandboxEnabled: boolean;
    /** The agent's tool allowlist; `null` means no allowlist. */
    readonly enabledTools: readonly string[] | null;
    readonly readOnly: boolean;
  };
  /** Whether the paying principal's tier may run machines. */
  readonly tierEligible: boolean;
};

export const decideToolExposure = (_options: DecideToolExposureOptions): readonly BrowserToolName[] => {
  throw new Error('decideToolExposure: not implemented (RED)');
};
