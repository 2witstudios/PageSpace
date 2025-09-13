"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelMessagesRelations = exports.channelMessages = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const auth_1 = require("./auth");
const core_1 = require("./core");
const cuid2_1 = require("@paralleldrive/cuid2");
exports.channelMessages = (0, pg_core_1.pgTable)('channel_messages', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    content: (0, pg_core_1.text)('content').notNull(),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    pageId: (0, pg_core_1.text)('pageId').notNull().references(() => core_1.pages.id, { onDelete: 'cascade' }),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
}, (table) => {
    return {
        pageIdx: (0, pg_core_1.index)('channel_messages_page_id_idx').on(table.pageId),
    };
});
exports.channelMessagesRelations = (0, drizzle_orm_1.relations)(exports.channelMessages, ({ one }) => ({
    page: one(core_1.pages, {
        fields: [exports.channelMessages.pageId],
        references: [core_1.pages.id],
    }),
    user: one(auth_1.users, {
        fields: [exports.channelMessages.userId],
        references: [auth_1.users.id],
    }),
}));
