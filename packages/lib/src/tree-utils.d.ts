export declare function buildTree<T extends {
    id: string;
    parentId: string | null;
}>(nodes: T[]): (T & {
    children: T[];
})[];
//# sourceMappingURL=tree-utils.d.ts.map