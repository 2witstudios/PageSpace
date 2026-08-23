CREATE TABLE "sheet_cell_deps" (
	"tabId" text NOT NULL,
	"address" text NOT NULL,
	"dependsOn" text[] NOT NULL,
	"dependents" text[] NOT NULL,
	CONSTRAINT "sheet_cell_deps_tabId_address_pk" PRIMARY KEY("tabId","address")
);
--> statement-breakpoint
CREATE TABLE "sheet_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"pageId" text NOT NULL,
	"tabId" text,
	"seq" bigserial NOT NULL,
	"actorUserId" text,
	"actorEmail" text,
	"changeGroupId" text,
	"op" text NOT NULL,
	"address" text,
	"rowIndex" integer,
	"before" jsonb,
	"after" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_range_deps" (
	"id" text PRIMARY KEY NOT NULL,
	"tabId" text NOT NULL,
	"formulaAddress" text NOT NULL,
	"rowStart" integer NOT NULL,
	"rowEnd" integer,
	"colStart" integer NOT NULL,
	"colEnd" integer,
	CONSTRAINT "sheet_range_deps_bounds_ordered" CHECK (("sheet_range_deps"."rowEnd" IS NULL OR "sheet_range_deps"."rowEnd" >= "sheet_range_deps"."rowStart") AND ("sheet_range_deps"."colEnd" IS NULL OR "sheet_range_deps"."colEnd" >= "sheet_range_deps"."colStart"))
);
--> statement-breakpoint
CREATE TABLE "sheet_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"tabId" text NOT NULL,
	"pageId" text NOT NULL,
	"rowIndex" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sheet_rows_tab_row_unique" UNIQUE("tabId","rowIndex"),
	CONSTRAINT "sheet_rows_row_index_non_negative" CHECK ("sheet_rows"."rowIndex" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sheet_tabs" (
	"id" text PRIMARY KEY NOT NULL,
	"pageId" text NOT NULL,
	"tabIndex" integer NOT NULL,
	"name" text NOT NULL,
	"rowCount" integer NOT NULL,
	"columnCount" integer NOT NULL,
	"frozenRows" integer,
	"frozenColumns" integer,
	"columnFormats" jsonb,
	"columnWidths" jsonb,
	"rowHeights" jsonb,
	"ranges" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sheet_tabs_page_tab_unique" UNIQUE("pageId","tabIndex"),
	CONSTRAINT "sheet_tabs_extent_non_negative" CHECK ("sheet_tabs"."rowCount" >= 0 AND "sheet_tabs"."columnCount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sheet_cell_deps" ADD CONSTRAINT "sheet_cell_deps_tabId_sheet_tabs_id_fk" FOREIGN KEY ("tabId") REFERENCES "public"."sheet_tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_changes" ADD CONSTRAINT "sheet_changes_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_changes" ADD CONSTRAINT "sheet_changes_actorUserId_users_id_fk" FOREIGN KEY ("actorUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_range_deps" ADD CONSTRAINT "sheet_range_deps_tabId_sheet_tabs_id_fk" FOREIGN KEY ("tabId") REFERENCES "public"."sheet_tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_rows" ADD CONSTRAINT "sheet_rows_tabId_sheet_tabs_id_fk" FOREIGN KEY ("tabId") REFERENCES "public"."sheet_tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_rows" ADD CONSTRAINT "sheet_rows_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_tabs" ADD CONSTRAINT "sheet_tabs_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sheet_cell_deps_tab_idx" ON "sheet_cell_deps" USING btree ("tabId");--> statement-breakpoint
CREATE INDEX "sheet_changes_page_seq_idx" ON "sheet_changes" USING btree ("pageId","seq");--> statement-breakpoint
CREATE INDEX "sheet_changes_tab_seq_idx" ON "sheet_changes" USING btree ("tabId","seq");--> statement-breakpoint
CREATE INDEX "sheet_changes_created_at_idx" ON "sheet_changes" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "sheet_range_deps_tab_idx" ON "sheet_range_deps" USING btree ("tabId");--> statement-breakpoint
CREATE INDEX "sheet_range_deps_cover_idx" ON "sheet_range_deps" USING btree ("tabId","rowStart","rowEnd");--> statement-breakpoint
CREATE INDEX "sheet_range_deps_formula_idx" ON "sheet_range_deps" USING btree ("tabId","formulaAddress");--> statement-breakpoint
CREATE INDEX "sheet_rows_page_row_idx" ON "sheet_rows" USING btree ("pageId","rowIndex");--> statement-breakpoint
CREATE INDEX "sheet_rows_tab_row_idx" ON "sheet_rows" USING btree ("tabId","rowIndex");--> statement-breakpoint
CREATE INDEX "sheet_rows_cells_gin" ON "sheet_rows" USING gin ("cells");--> statement-breakpoint
CREATE INDEX "sheet_tabs_page_id_idx" ON "sheet_tabs" USING btree ("pageId");