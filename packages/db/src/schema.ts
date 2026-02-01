export * from './schema/auth';
export * from './schema/sessions';
export * from './schema/core';
export * from './schema/permissions';
export * from './schema/members';
export * from './schema/chat';
export * from './schema/ai';
export * from './schema/dashboard';
export * from './schema/conversations';
export * from './schema/notifications';
export * from './schema/email-notifications';
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

import * as auth from './schema/auth';
import * as sessions from './schema/sessions';
import * as core from './schema/core';
import * as permissions from './schema/permissions';
import * as members from './schema/members';
import * as chat from './schema/chat';
import * as ai from './schema/ai';
import * as dashboard from './schema/dashboard';
import * as conversations from './schema/conversations';
import * as notifications from './schema/notifications';
import * as emailNotifications from './schema/email-notifications';
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

export const schema = {
  ...auth,
  ...sessions,
  ...core,
  ...permissions,
  ...members,
  ...chat,
  ...ai,
  ...dashboard,
  ...conversations,
  ...notifications,
  ...emailNotifications,
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
};
