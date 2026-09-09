/**
 * The ONE place the CLI touches `@pagespace/lib` at runtime — the pure,
 * I/O-free env-bridge core (invariants 3–7 live there; nothing here decides
 * anything, this file only re-exports).
 *
 * WHY A SINGLE SEAM. `@pagespace/lib` is a workspace devDependency that is not
 * publishable (it carries server and database code), so the published
 * `@pagespace/cli` cannot resolve it. The build therefore BUNDLES this module:
 * `tsc` emits it (and its types) like any other file, then
 * `scripts/bundle-lib-core.mjs` runs esbuild over this file with
 * `@pagespace/lib` aliased to the library's SOURCE tree and writes the
 * self-contained result over `dist/env-bridge/lib-core.js`. Only the pure core
 * and its zod schemas are pulled in; `zod` stays external (already a CLI
 * dependency). Every other CLI module imports from `./lib-core.js`, never from
 * `@pagespace/lib` — `__tests__/invariants.test.ts` pins that, and
 * `__tests__/published-entry-no-lib.test.ts` walks the built dist to prove no
 * `@pagespace/lib` specifier survives in any runtime import.
 */
export { GRANT_OPS, GRANT_MAX_CLOCK_SKEW_MS, decodeBase64, verifyGrant } from '@pagespace/lib/env-bridge/grant';
export type { ApprovalIntent, Ed25519Verify, Grant, GrantOp, GrantPrincipal, GrantVerdict, HashBytes, NonceStore, VerifyGrantInput } from '@pagespace/lib/env-bridge/grant';
export { executionRequestForFrame, GRANT_FRAME_TYPES, grantRequestForFrame } from '@pagespace/lib/env-bridge/grant-args';
export type { GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
export { decideExecution } from '@pagespace/lib/env-bridge/decide-execution';
export type { DecideExecutionInput, ExecutionVerdict, NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
export { APPROVAL_SCOPES, APPROVALS_FILE_VERSION, DEFAULT_APPROVAL_SCOPE, approvalExpiry, isDurableScope, parseApprovalsFile } from '@pagespace/lib/env-bridge/decide-approval';
export type { ApprovalScope, DurableApproval } from '@pagespace/lib/env-bridge/decide-approval';
export { describeSensitiveWrite } from '@pagespace/lib/env-bridge/classify-write';
export type { SensitiveWrite } from '@pagespace/lib/env-bridge/classify-write';
export { parseMachinePolicy } from '@pagespace/lib/env-bridge/policy-types';
export { policyWarnings } from '@pagespace/lib/env-bridge/policy-warnings';
export type { PolicyWarning, PolicyWarningInput, PolicyWarningOptions } from '@pagespace/lib/env-bridge/policy-warnings';
export type { AdvertisedCapabilities, MachinePolicy, ServerPolicy } from '@pagespace/lib/env-bridge/policy-types';
export type { PathProbe } from '@pagespace/lib/env-bridge/confine-path';
export { encodeApprovalRevokeForSigning, encodeHelloForSigning, encodeResultForSigning, machineResultBindingId, OWNER_APPROVAL_SIGNING_DOMAIN, resultHashForFrame, verifyPause, verifyRevoke } from '@pagespace/lib/env-bridge/machine-signatures';
export { deriveOwnerApprovalChallenge, ownerApprovalRequestHash, pendingRequestForWire, verifyOwnerApproval } from '@pagespace/lib/env-bridge/owner-approval';
export type { EcJwkPublic, Es256Verify, OwnerApprovalAssertion, OwnerApprovalDenyReason, OwnerApprovalRequest, OwnerApprovalVerdict, PinnedOwnerApproval, PinnedOwnerCredential, Sha256Bytes } from '@pagespace/lib/env-bridge/owner-approval';
export type { MachineResultFrame, MachineResultFrameType } from '@pagespace/lib/env-bridge/machine-signatures';
export { decodeFrame, encodeFrame, execOutputCeiling, fsReadContentCeiling } from '@pagespace/lib/env-bridge/frame-codec';
export type { Frame, FrameLimits, PendingApproval } from '@pagespace/lib/env-bridge/frame-codec';
export { initialBridgeSession, isSupersededClose, reduceBridgeSession } from '@pagespace/lib/env-bridge/bridge-session';
export type { BridgeEffect, BridgeSessionState, BridgeStatus, HelloFrame } from '@pagespace/lib/env-bridge/bridge-session';
export { isHardDeniedEnvVar } from '@pagespace/lib/env-bridge/scrub-env';
