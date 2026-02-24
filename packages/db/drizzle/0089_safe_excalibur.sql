CREATE INDEX IF NOT EXISTS "pages_drive_id_is_trashed_type_idx" ON "pages" USING btree ("driveId","isTrashed","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_is_read_created_at_idx" ON "notifications" USING btree ("userId","isRead","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_page_id_is_pinned_created_at_idx" ON "page_versions" USING btree ("pageId","isPinned","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_items_due_date_idx" ON "task_items" USING btree ("dueDate");