export declare const permissionAction: import("drizzle-orm/pg-core").PgEnum<["VIEW", "EDIT", "SHARE", "DELETE"]>;
export declare const subjectType: import("drizzle-orm/pg-core").PgEnum<["USER"]>;
export declare const permissions: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "permissions";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "permissions";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: true;
            enumValues: [string, ...string[]];
            baseColumn: never;
            generated: undefined;
        }, {}, {}>;
        action: import("drizzle-orm/pg-core").PgColumn<{
            name: "action";
            tableName: "permissions";
            dataType: "string";
            columnType: "PgEnumColumn";
            data: "VIEW" | "EDIT" | "SHARE" | "DELETE";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["VIEW", "EDIT", "SHARE", "DELETE"];
            baseColumn: never;
            generated: undefined;
        }, {}, {}>;
        subjectType: import("drizzle-orm/pg-core").PgColumn<{
            name: "subjectType";
            tableName: "permissions";
            dataType: "string";
            columnType: "PgEnumColumn";
            data: "USER";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["USER"];
            baseColumn: never;
            generated: undefined;
        }, {}, {}>;
        subjectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "subjectId";
            tableName: "permissions";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            generated: undefined;
        }, {}, {}>;
        pageId: import("drizzle-orm/pg-core").PgColumn<{
            name: "pageId";
            tableName: "permissions";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "createdAt";
            tableName: "permissions";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const permissionsRelations: import("drizzle-orm").Relations<"permissions", {
    page: import("drizzle-orm").One<"pages", true>;
}>;
//# sourceMappingURL=permissions.d.ts.map