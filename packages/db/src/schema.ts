export * from './schema/auth';
export * from './schema/core';
export * from './schema/permissions';
export * from './schema/members';
export * from './schema/chat';
export * from './schema/ai';
export * from './schema/dashboard';
export * from './schema/conversations';
export * from './schema/notifications';
export * from './schema/monitoring';
export * from './schema/social';
export * from './schema/subscriptions';

import * as auth from './schema/auth';
import * as core from './schema/core';
import * as permissions from './schema/permissions';
import * as members from './schema/members';
import * as chat from './schema/chat';
import * as ai from './schema/ai';
import * as dashboard from './schema/dashboard';
import * as conversations from './schema/conversations';
import * as notifications from './schema/notifications';
import * as monitoring from './schema/monitoring';
import * as social from './schema/social';
import * as subscriptions from './schema/subscriptions';

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
  ...monitoring,
  ...social,
  ...subscriptions,
};