"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.isNotNull = exports.isNull = exports.ne = exports.lte = exports.lt = exports.gte = exports.gt = exports.between = exports.exists = exports.ilike = exports.like = exports.min = exports.max = exports.avg = exports.sum = exports.count = exports.desc = exports.asc = exports.sql = exports.inArray = exports.not = exports.or = exports.and = exports.eq = void 0;
const node_postgres_1 = require("drizzle-orm/node-postgres");
const pg_1 = require("pg");
const schema_1 = require("./schema");
require("dotenv/config");
// Re-export commonly used drizzle-orm functions
var drizzle_orm_1 = require("drizzle-orm");
Object.defineProperty(exports, "eq", { enumerable: true, get: function () { return drizzle_orm_1.eq; } });
Object.defineProperty(exports, "and", { enumerable: true, get: function () { return drizzle_orm_1.and; } });
Object.defineProperty(exports, "or", { enumerable: true, get: function () { return drizzle_orm_1.or; } });
Object.defineProperty(exports, "not", { enumerable: true, get: function () { return drizzle_orm_1.not; } });
Object.defineProperty(exports, "inArray", { enumerable: true, get: function () { return drizzle_orm_1.inArray; } });
Object.defineProperty(exports, "sql", { enumerable: true, get: function () { return drizzle_orm_1.sql; } });
Object.defineProperty(exports, "asc", { enumerable: true, get: function () { return drizzle_orm_1.asc; } });
Object.defineProperty(exports, "desc", { enumerable: true, get: function () { return drizzle_orm_1.desc; } });
Object.defineProperty(exports, "count", { enumerable: true, get: function () { return drizzle_orm_1.count; } });
Object.defineProperty(exports, "sum", { enumerable: true, get: function () { return drizzle_orm_1.sum; } });
Object.defineProperty(exports, "avg", { enumerable: true, get: function () { return drizzle_orm_1.avg; } });
Object.defineProperty(exports, "max", { enumerable: true, get: function () { return drizzle_orm_1.max; } });
Object.defineProperty(exports, "min", { enumerable: true, get: function () { return drizzle_orm_1.min; } });
Object.defineProperty(exports, "like", { enumerable: true, get: function () { return drizzle_orm_1.like; } });
Object.defineProperty(exports, "ilike", { enumerable: true, get: function () { return drizzle_orm_1.ilike; } });
Object.defineProperty(exports, "exists", { enumerable: true, get: function () { return drizzle_orm_1.exists; } });
Object.defineProperty(exports, "between", { enumerable: true, get: function () { return drizzle_orm_1.between; } });
Object.defineProperty(exports, "gt", { enumerable: true, get: function () { return drizzle_orm_1.gt; } });
Object.defineProperty(exports, "gte", { enumerable: true, get: function () { return drizzle_orm_1.gte; } });
Object.defineProperty(exports, "lt", { enumerable: true, get: function () { return drizzle_orm_1.lt; } });
Object.defineProperty(exports, "lte", { enumerable: true, get: function () { return drizzle_orm_1.lte; } });
Object.defineProperty(exports, "ne", { enumerable: true, get: function () { return drizzle_orm_1.ne; } });
Object.defineProperty(exports, "isNull", { enumerable: true, get: function () { return drizzle_orm_1.isNull; } });
Object.defineProperty(exports, "isNotNull", { enumerable: true, get: function () { return drizzle_orm_1.isNotNull; } });
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
});
exports.db = (0, node_postgres_1.drizzle)(pool, { schema: schema_1.schema });
// Export schema for external use
__exportStar(require("./schema"), exports);
