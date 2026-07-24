export * from './schema/auth';
export * from './schema/sessions';
export * from './schema/core';
export * from './schema/members';
export * from './schema/chat';
export * from './schema/dashboard';
export * from './schema/conversations';
export * from './schema/notifications';
export * from './schema/email-notifications';
export * from './schema/toast-notification-preferences';
export * from './schema/display-preferences';
export * from './schema/monitoring';
export * from './schema/versioning';
export * from './schema/social';
export * from './schema/subscriptions';
export * from './schema/contact';
export * from './schema/feedback';
export * from './schema/storage';
export * from './schema/tasks';
export * from './schema/security-audit';
export * from './schema/page-views';
export * from './schema/hotkeys';
export * from './schema/push-notifications';
export * from './schema/integrations';
export * from './schema/personalization';
export * from './schema/automation-preferences';
export * from './schema/calendar';
export * from './schema/calendar-triggers';
export * from './schema/workflows';
export * from './schema/workflow-runs';
export * from './schema/task-triggers';
export * from './schema/rate-limit-buckets';
export * from './schema/revoked-service-tokens';
export * from './schema/auth-handoff-tokens';
export * from './schema/pending-invites';
export * from './schema/pending-page-invites';
export * from './schema/pending-connection-invites';
export * from './schema/ai-streams';
export * from './schema/share-links';
export * from './schema/zoom';
export * from './schema/webhook-triggers';
export * from './schema/drafts';
export * from './schema/machine-sessions';
export * from './schema/published-pages';
export * from './schema/credits';
export * from './schema/commands';
export * from './schema/ai-compaction';
export * from './schema/custom-domains';
export * from './schema/incidents';
export * from './schema/data-subject-requests';
export * from './schema/oauth';
export * from './schema/form-targets';
export * from './schema/machine-projects';
export * from './schema/machine-branches';
export * from './schema/machine-sprite-reclaims';
export * from './schema/machine-agent-terminals';
export * from './schema/machine-workspaces';
export * from './schema/machine-workspace-bootstraps';
export * from './schema/machine-panes';
export * from './schema/email-broadcasts';
export * from './schema/page-webhooks';

import * as auth from './schema/auth';
import * as sessions from './schema/sessions';
import * as core from './schema/core';
import * as members from './schema/members';
import * as chat from './schema/chat';
import * as dashboard from './schema/dashboard';
import * as conversations from './schema/conversations';
import * as notifications from './schema/notifications';
import * as emailNotifications from './schema/email-notifications';
import * as toastNotificationPreferences from './schema/toast-notification-preferences';
import * as displayPreferences from './schema/display-preferences';
import * as monitoring from './schema/monitoring';
import * as versioning from './schema/versioning';
import * as social from './schema/social';
import * as subscriptions from './schema/subscriptions';
import * as contact from './schema/contact';
import * as feedback from './schema/feedback';
import * as storage from './schema/storage';
import * as tasks from './schema/tasks';
import * as securityAudit from './schema/security-audit';
import * as pageViews from './schema/page-views';
import * as hotkeys from './schema/hotkeys';
import * as pushNotifications from './schema/push-notifications';
import * as integrations from './schema/integrations';
import * as personalization from './schema/personalization';
import * as automationPreferences from './schema/automation-preferences';
import * as calendar from './schema/calendar';
import * as calendarTriggers from './schema/calendar-triggers';
import * as workflows from './schema/workflows';
import * as workflowRuns from './schema/workflow-runs';
import * as taskTriggers from './schema/task-triggers';
import * as rateLimitBuckets from './schema/rate-limit-buckets';
import * as revokedServiceTokens from './schema/revoked-service-tokens';
import * as authHandoffTokens from './schema/auth-handoff-tokens';
import * as pendingInvites from './schema/pending-invites';
import * as pendingPageInvites from './schema/pending-page-invites';
import * as pendingConnectionInvites from './schema/pending-connection-invites';
import * as aiStreams from './schema/ai-streams';
import * as shareLinks from './schema/share-links';
import * as zoom from './schema/zoom';
import * as webhookTriggers from './schema/webhook-triggers';
import * as drafts from './schema/drafts';
import * as machineSessions from './schema/machine-sessions';
import * as publishedPages from './schema/published-pages';
import * as credits from './schema/credits';
import * as commands from './schema/commands';
import * as aiCompaction from './schema/ai-compaction';
import * as customDomains from './schema/custom-domains';
import * as incidents from './schema/incidents';
import * as dataSubjectRequests from './schema/data-subject-requests';
import * as oauth from './schema/oauth';
import * as formTargets from './schema/form-targets';
import * as machineProjects from './schema/machine-projects';
import * as machineBranches from './schema/machine-branches';
import * as machineSpriteReclaims from './schema/machine-sprite-reclaims';
import * as machineAgentTerminals from './schema/machine-agent-terminals';
import * as machineWorkspaces from './schema/machine-workspaces';
import * as machineWorkspaceBootstraps from './schema/machine-workspace-bootstraps';
import * as machinePanes from './schema/machine-panes';
import * as emailBroadcasts from './schema/email-broadcasts';
import * as pageWebhooks from './schema/page-webhooks';

export const schema = {
  ...auth,
  ...sessions,
  ...core,
  ...members,
  ...chat,
  ...dashboard,
  ...conversations,
  ...notifications,
  ...emailNotifications,
  ...toastNotificationPreferences,
  ...displayPreferences,
  ...monitoring,
  ...versioning,
  ...social,
  ...subscriptions,
  ...contact,
  ...feedback,
  ...storage,
  ...tasks,
  ...securityAudit,
  ...pageViews,
  ...hotkeys,
  ...pushNotifications,
  ...integrations,
  ...personalization,
  ...automationPreferences,
  ...calendar,
  ...calendarTriggers,
  ...workflows,
  ...workflowRuns,
  ...taskTriggers,
  ...rateLimitBuckets,
  ...revokedServiceTokens,
  ...authHandoffTokens,
  ...pendingInvites,
  ...pendingPageInvites,
  ...pendingConnectionInvites,
  ...aiStreams,
  ...shareLinks,
  ...zoom,
  ...webhookTriggers,
  ...drafts,
  ...machineSessions,
  ...publishedPages,
  ...credits,
  ...commands,
  ...aiCompaction,
  ...customDomains,
  ...incidents,
  ...dataSubjectRequests,
  ...oauth,
  ...formTargets,
  ...machineProjects,
  ...machineBranches,
  ...machineSpriteReclaims,
  ...machineAgentTerminals,
  ...machineWorkspaces,
  ...machineWorkspaceBootstraps,
  ...machinePanes,
  ...emailBroadcasts,
  ...pageWebhooks,
};
