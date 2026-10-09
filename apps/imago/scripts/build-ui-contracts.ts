import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

// Copy only the declared API shapes consumed by the UI. Importing the service
// barrels for these types otherwise inventories server executors as UI source.
const declarations: Record<string, readonly string[]> = {
  'lib/websocket/socket-utils.ts': ['PageOperation', 'DriveOperation', 'DriveMemberOperation', 'TaskOperation', 'CreditsOperation', 'InboxOperation', 'ActivityEventPayload', 'PageEventPayload', 'DriveEventPayload', 'DriveMemberEventPayload', 'TaskEventPayload', 'CreditsEventPayload', 'InboxEventPayload', 'ThreadReplyCountUpdatedPayload', 'AiStreamStartPayload', 'AiStreamCompletePayload', 'ChatUserMessagePayload', 'ChatMessageEditedPayload', 'ChatMessageDeletedPayload', 'ChatUndoAppliedPayload', 'ChatConversationAddedPayload', 'ChatGlobalConversationAddedPayload', 'ChatConversationRenamedPayload', 'ChatConversationDeletedPayload', 'AgentGrantChangedPayload', 'ShellActivityEventPayload'],
  'app/api/user/favorites/route.ts': ['FavoriteItem'],
  'app/api/user/recents/route.ts': ['RecentPage'],
  'services/api/permission-management-service.ts': ['RolePermissionFlags', 'RoleGrant'],
  'services/api/ai-undo-service.ts': ['MessageSource', 'AiUndoPreview', 'UndoMode'],
  'services/api/rollback-to-point-service.ts': ['RollbackToPointContext', 'RollbackToPointPreview'],
  'services/api/drive-backup-service.ts': ['DriveBackupSource', 'DriveBackupSummary', 'DriveBackupWithDriveName'],
  'services/api/snapshot-pages-service.ts': ['SnapshotPageNode'],
  'services/api/restore-diff-service.ts': ['RestoreDiff'],
  'lib/ai/tools/sheet-format-tools.ts': ['HUE_NAMES', 'aiNumberFormatSchema', 'aiCellFormatSchema', 'columnSchema', 'rangeSchema', 'rowNumberSchema', 'countSchema', 'COLUMN_ROLES', 'regionColumnSchema', 'regionSchema', 'RegionInput', 'FORMAT_OPS', 'formatOpSchema', 'FormatOpInput', 'OPERATORS', 'anchorSchema', 'operandSchema', 'ruleSchema', 'RuleInput'],
  'lib/ai/core/command-processor.ts': ['CommandSkipReason', 'COMMAND_SKIP_REASON_TEXT', 'CommandExecutionData'],
};
const output = [
  "import type { AttachmentMeta } from '@pagespace/lib/types';",
  "export type { PresenceViewer, PresencePageViewersPayload } from '@pagespace/lib/types';",
  "export type { AccessRevokedPayload } from '@pagespace/lib/realtime/kick-client';",
  "import { z } from 'zod';",
  "import { PALETTE, MAX_DECIMALS, MIN_FONT_SIZE, MAX_FONT_SIZE, MAX_ADDRESSABLE_ROW, MAX_REGION_HEADER_ROWS, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, type ConditionalOperator } from '@pagespace/lib/sheets/sheet';",
  '/** Generated UI declarations from classic sources by build-ui-contracts.ts. */',
  "import type { PageType } from '@pagespace/lib/utils/enums';",
  "import type { ConversationAccessRow } from '@pagespace/lib/permissions/conversation-access';",
  "import type { ActivityActionPreview } from '@/retained/types/activity-actions';",
];
for (const [path, names] of Object.entries(declarations)) {
  const source = await readFile(new URL(`../../web/src/${path}`, import.meta.url), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  for (const name of names) {
    const statement = file.statements.find(node =>
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) ? node.name.text === name :
        ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(file) === name));
    if (!statement) throw new Error(`Classic declaration missing: ${path}#${name}`);
    const text = statement.getText(file);
    output.push(`// ${path}#${name}`, ['regionSchema', 'formatOpSchema', 'ruleSchema'].includes(name) ? `export ${text}` : text);
  }
}
await writeFile(new URL('../src/retained-adapters/ui-contracts.ts', import.meta.url), output.join('\n') + '\n');
