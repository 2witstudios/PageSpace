"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mcpTokensRelations = exports.refreshTokensRelations = exports.usersRelations = exports.mcpTokens = exports.refreshTokens = exports.users = exports.authProvider = exports.userRole = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const cuid2_1 = require("@paralleldrive/cuid2");
const core_1 = require("./core");
exports.userRole = (0, pg_core_1.pgEnum)('UserRole', ['user', 'admin']);
exports.authProvider = (0, pg_core_1.pgEnum)('AuthProvider', ['email', 'google', 'both']);
exports.users = (0, pg_core_1.pgTable)('users', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    name: (0, pg_core_1.text)('name').notNull(),
    email: (0, pg_core_1.text)('email').unique().notNull(),
    emailVerified: (0, pg_core_1.timestamp)('emailVerified', { mode: 'date' }),
    image: (0, pg_core_1.text)('image'),
    password: (0, pg_core_1.text)('password'),
    googleId: (0, pg_core_1.text)('googleId').unique(),
    provider: (0, exports.authProvider)('provider').default('email').notNull(),
    tokenVersion: (0, pg_core_1.integer)('tokenVersion').default(0).notNull(),
    role: (0, exports.userRole)('role').default('user').notNull(),
    currentAiProvider: (0, pg_core_1.text)('currentAiProvider').default('pagespace').notNull(),
    currentAiModel: (0, pg_core_1.text)('currentAiModel').default('qwen/qwen3-coder:free').notNull(),
    // Storage tracking fields
    storageUsedBytes: (0, pg_core_1.real)('storageUsedBytes').default(0).notNull(),
    storageQuotaBytes: (0, pg_core_1.real)('storageQuotaBytes').default(524288000).notNull(), // 500MB default
    storageTier: (0, pg_core_1.text)('storageTier').default('free').notNull(),
    activeUploads: (0, pg_core_1.integer)('activeUploads').default(0).notNull(),
    lastStorageCalculated: (0, pg_core_1.timestamp)('lastStorageCalculated', { mode: 'date' }),
});
exports.refreshTokens = (0, pg_core_1.pgTable)('refresh_tokens', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => exports.users.id, { onDelete: 'cascade' }),
    token: (0, pg_core_1.text)('token').unique().notNull(),
    device: (0, pg_core_1.text)('device'),
    ip: (0, pg_core_1.text)('ip'),
    userAgent: (0, pg_core_1.text)('userAgent'),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
    return {
        userIdx: (0, pg_core_1.index)('refresh_tokens_user_id_idx').on(table.userId),
    };
});
exports.mcpTokens = (0, pg_core_1.pgTable)('mcp_tokens', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => exports.users.id, { onDelete: 'cascade' }),
    token: (0, pg_core_1.text)('token').unique().notNull(),
    name: (0, pg_core_1.text)('name').notNull(),
    lastUsed: (0, pg_core_1.timestamp)('lastUsed', { mode: 'date' }),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    revokedAt: (0, pg_core_1.timestamp)('revokedAt', { mode: 'date' }),
}, (table) => {
    return {
        userIdx: (0, pg_core_1.index)('mcp_tokens_user_id_idx').on(table.userId),
        tokenIdx: (0, pg_core_1.index)('mcp_tokens_token_idx').on(table.token),
    };
});
const ai_1 = require("./ai");
exports.usersRelations = (0, drizzle_orm_1.relations)(exports.users, ({ many }) => ({
    refreshTokens: many(exports.refreshTokens),
    chatMessages: many(core_1.chatMessages),
    aiSettings: many(ai_1.userAiSettings),
    mcpTokens: many(exports.mcpTokens),
}));
exports.refreshTokensRelations = (0, drizzle_orm_1.relations)(exports.refreshTokens, ({ one }) => ({
    user: one(exports.users, {
        fields: [exports.refreshTokens.userId],
        references: [exports.users.id],
    }),
}));
exports.mcpTokensRelations = (0, drizzle_orm_1.relations)(exports.mcpTokens, ({ one }) => ({
    user: one(exports.users, {
        fields: [exports.mcpTokens.userId],
        references: [exports.users.id],
    }),
}));
