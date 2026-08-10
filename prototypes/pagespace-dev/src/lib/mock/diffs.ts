import type { AgentDiff, DiffFile } from "./types";

const webhookFanout: DiffFile[] = [
  {
    path: "apps/web/src/app/api/webhooks/fanout.ts",
    additions: 96,
    deletions: 4,
    lines: [
      { kind: "hunk", text: "@@ -12,6 +12,38 @@ import { after } from 'next/server';" },
      { kind: "context", text: "import { db } from '@pagespace/db/db';" },
      { kind: "add", text: "import { executeWorkflow } from '@pagespace/lib/services/workflows';" },
      { kind: "add", text: "import { dispatchMapFor } from './dispatch-map';" },
      { kind: "context", text: "" },
      { kind: "add", text: "/** Fan a verified webhook event out to every trigger row, off-response. */" },
      { kind: "add", text: "export function fanOut(event: VerifiedWebhookEvent, triggers: TriggerRow[]) {" },
      { kind: "add", text: "  after(async () => {" },
      { kind: "add", text: "    for (const trigger of triggers) {" },
      { kind: "add", text: "      const handler = dispatchMapFor(trigger.pageType);" },
      { kind: "add", text: "      if (!handler) continue;" },
      { kind: "add", text: "      await executeWorkflow(handler.workflowOf(trigger, event));" },
      { kind: "add", text: "    }" },
      { kind: "add", text: "  });" },
      { kind: "add", text: "}" },
    ],
  },
  {
    path: "apps/web/src/app/api/webhooks/dispatch-map.ts",
    additions: 58,
    deletions: 12,
    lines: [
      { kind: "hunk", text: "@@ -30,10 +30,14 @@ const HANDLERS = {" },
      { kind: "context", text: "const HANDLERS: Partial<Record<PageType, DispatchHandler>> = {" },
      { kind: "del", text: "  CHANNEL: undefined, // TODO" },
      { kind: "add", text: "  CHANNEL: channelHandler," },
      { kind: "add", text: "  AI_AGENT: agentHandler," },
      { kind: "context", text: "};" },
    ],
  },
  {
    path: "packages/lib/src/services/webhooks/__tests__/fanout.test.ts",
    additions: 91,
    deletions: 22,
    lines: [
      { kind: "hunk", text: "@@ -1,4 +1,18 @@" },
      { kind: "add", text: "describe('fanOut', () => {" },
      { kind: "add", text: "  it('dispatches one workflow per trigger row', async () => {" },
      { kind: "add", text: "    const runs = await collectWorkflows(() => fanOut(event, triggers));" },
      { kind: "add", text: "    expect(runs).toHaveLength(triggers.length);" },
      { kind: "add", text: "  });" },
      { kind: "add", text: "});" },
    ],
  },
];

const authFix: DiffFile[] = [
  {
    path: "packages/lib/src/auth/session-service.ts",
    additions: 34,
    deletions: 11,
    lines: [
      { kind: "hunk", text: "@@ -204,9 +204,17 @@ export async function refreshSession(" },
      { kind: "del", text: "  await revokeToken(oldToken.id);" },
      { kind: "add", text: "  // Device tokens keep their grace window across refresh: revoking" },
      { kind: "add", text: "  // instantly (the #2084 behavior) logs out every other window." },
      { kind: "add", text: "  await revokeTokenAfterGrace(oldToken.id, GRACE_WINDOW_MS);" },
      { kind: "context", text: "  return mintSession(user, device);" },
    ],
  },
  {
    path: "apps/web/src/hooks/__tests__/useAuth.test.tsx",
    additions: 27,
    deletions: 6,
    lines: [
      { kind: "hunk", text: "@@ -80,6 +80,20 @@ describe('AuthProvider', () => {" },
      { kind: "add", text: "  it('keeps the device grace window across a token refresh', async () => {" },
      { kind: "add", text: "    await refresh();" },
      { kind: "add", text: "    expect(revokeTokenAfterGrace).toHaveBeenCalled();" },
      { kind: "add", text: "  });" },
    ],
  },
];

const sheetview: DiffFile[] = [
  {
    path: "apps/web/src/components/sheet/SheetToolbar.tsx",
    additions: 182,
    deletions: 0,
    lines: [
      { kind: "hunk", text: "@@ -0,0 +1,182 @@" },
      { kind: "add", text: "export function SheetToolbar({ selection, onFormat }: SheetToolbarProps) {" },
      { kind: "add", text: "  // Pure: every effect (clipboard, store) is injected by the shell." },
      { kind: "add", text: "  …" },
      { kind: "add", text: "}" },
    ],
  },
  {
    path: "apps/web/src/components/sheet/SheetView.tsx",
    additions: 40,
    deletions: 468,
    lines: [
      { kind: "hunk", text: "@@ -120,470 +120,42 @@" },
      { kind: "del", text: "  // 400 lines of inline toolbar JSX removed…" },
      { kind: "add", text: "  <SheetToolbar selection={selection} onFormat={applyFormat} />" },
      { kind: "add", text: "  <SheetGridBody grid={grid} onEdit={beginEdit} />" },
    ],
  },
];

const flaky: DiffFile[] = [
  {
    path: "apps/web/src/components/ai/AiChatView.tsx",
    additions: 12,
    deletions: 3,
    lines: [
      { kind: "hunk", text: "@@ -88,7 +88,16 @@" },
      { kind: "del", text: "  setStream(next);" },
      { kind: "add", text: "  // Guard: never swap the store mid-settle (the reflake tell)." },
      { kind: "add", text: "  if (!settling.current) setStream(next);" },
    ],
  },
];

/** Per-agent diffs, keyed by agent id. Missing agent/scope = clean. */
export const agentDiffs: Record<string, AgentDiff> = {
  "ag-webhooks": {
    uncommitted: [webhookFanout[0]],
    committed: webhookFanout.slice(1),
    branch: webhookFanout,
  },
  "ag-authfix": {
    uncommitted: authFix,
    branch: authFix,
  },
  "ag-sheetview": {
    committed: sheetview,
    branch: sheetview,
  },
  "ag-flaky": {
    uncommitted: flaky,
    branch: flaky,
  },
  "ag-cli-docs": {
    committed: [
      {
        path: "docs/reference/keys.md",
        additions: 88,
        deletions: 0,
        lines: [
          { kind: "hunk", text: "@@ -0,0 +1,88 @@" },
          { kind: "add", text: "# pagespace keys" },
          { kind: "add", text: "Mint, list, and activate drive-scoped API keys." },
        ],
      },
    ],
    branch: [
      {
        path: "docs/reference/keys.md",
        additions: 88,
        deletions: 0,
        lines: [
          { kind: "hunk", text: "@@ -0,0 +1,88 @@" },
          { kind: "add", text: "# pagespace keys" },
          { kind: "add", text: "Mint, list, and activate drive-scoped API keys." },
        ],
      },
    ],
  },
};
