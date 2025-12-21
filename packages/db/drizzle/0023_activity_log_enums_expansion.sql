-- Add new operation types to activity_operation enum
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'member_add';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'member_remove';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'member_role_change';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'login';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'logout';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'signup';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'password_change';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'email_change';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'token_create';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'token_revoke';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'upload';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'convert';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'account_delete';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'profile_update';
ALTER TYPE "activity_operation" ADD VALUE IF NOT EXISTS 'avatar_update';

-- Add new resource types to activity_resource enum
ALTER TYPE "activity_resource" ADD VALUE IF NOT EXISTS 'user';
ALTER TYPE "activity_resource" ADD VALUE IF NOT EXISTS 'member';
ALTER TYPE "activity_resource" ADD VALUE IF NOT EXISTS 'role';
ALTER TYPE "activity_resource" ADD VALUE IF NOT EXISTS 'file';
ALTER TYPE "activity_resource" ADD VALUE IF NOT EXISTS 'token';
ALTER TYPE "activity_resource" ADD VALUE IF NOT EXISTS 'device';
