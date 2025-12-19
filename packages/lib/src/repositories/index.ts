/**
 * Repository Seams - Clean boundaries for database operations
 *
 * These repositories provide testable seams that encapsulate database
 * access patterns. Tests should mock these repositories instead of
 * mocking ORM chains (select/from/where/update/set).
 */

export {
  accountRepository,
  type AccountRepository,
  type UserAccount,
  type OwnedDrive,
  type DriveMemberCount,
} from './account-repository';

export {
  activityLogRepository,
  type ActivityLogRepository,
  type AnonymizeResult,
} from './activity-log-repository';

export {
  pageRepository,
  type PageRepository,
  type PageRecord,
  type PageTypeValue,
  type CreatePageInput,
  type UpdatePageInput,
} from './page-repository';

export {
  driveRepository,
  type DriveRepository,
  type DriveRecord,
  type DriveBasic,
} from './drive-repository';

export {
  agentRepository,
  type AgentRepository,
  type AgentRecord,
  type AgentConfigUpdate,
} from './agent-repository';
