export * from './schema/auth';
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
export * from './schema/social';
export * from './schema/subscriptions';
export * from './schema/contact';
export * from './schema/storage';
export * from './schema/workflows';

import * as auth from './schema/auth';
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
import * as social from './schema/social';
import * as subscriptions from './schema/subscriptions';
import * as contact from './schema/contact';
import * as storage from './schema/storage';
import * as workflows from './schema/workflows';

export const schema = {
  ...auth,
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
  ...social,
  ...subscriptions,
  ...contact,
  ...storage,
  ...workflows,
};
