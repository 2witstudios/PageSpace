CREATE INDEX "user_personalization_bio_page_idx" ON "user_personalization" USING btree ("bioPageId");--> statement-breakpoint
CREATE INDEX "user_personalization_writing_style_page_idx" ON "user_personalization" USING btree ("writingStylePageId");--> statement-breakpoint
CREATE INDEX "user_personalization_rules_page_idx" ON "user_personalization" USING btree ("rulesPageId");