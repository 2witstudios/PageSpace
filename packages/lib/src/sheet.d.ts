import { PageType } from './enums';
export declare const SHEET_VERSION = 1;
export declare const SHEET_DEFAULT_ROWS = 20;
export declare const SHEET_DEFAULT_COLUMNS = 10;
export declare const SHEETDOC_MAGIC = "#%PAGESPACE_SHEETDOC";
export declare const SHEETDOC_VERSION = "v1";
export type SheetCellAddress = string;
export interface SheetData {
    version: number;
    rowCount: number;
    columnCount: number;
    cells: Record<SheetCellAddress, string>;
}
export type SheetPrimitive = number | string | boolean | '';
export interface SheetDocCellError {
    type: string;
    message?: string;
    details?: string[];
}
export interface SheetDocCell {
    formula?: string;
    value?: SheetPrimitive;
    type?: string;
    notes?: string[];
    error?: SheetDocCellError;
}
export interface SheetDocDependencyRecord {
    dependsOn: SheetCellAddress[];
    dependents: SheetCellAddress[];
}
export interface SheetDocSheet {
    name: string;
    order: number;
    meta: {
        rowCount: number;
        columnCount: number;
        frozenRows?: number;
        frozenColumns?: number;
        [key: string]: number | string | boolean | undefined;
    };
    columns: Record<string, Record<string, string | number | boolean>>;
    cells: Record<SheetCellAddress, SheetDocCell>;
    ranges: Record<string, Record<string, unknown>>;
    dependencies: Record<SheetCellAddress, SheetDocDependencyRecord>;
}
export interface SheetDoc {
    version: typeof SHEETDOC_VERSION;
    pageId?: string;
    sheets: SheetDocSheet[];
}
export interface SheetExternalReferenceToken {
    raw: string;
    label: string;
    normalizedLabel: string;
    identifier?: string;
    mentionType?: string;
}
export interface SheetExternalReferenceResolution {
    pageId: string;
    pageTitle: string;
    sheet?: SheetData;
    error?: string;
}
export interface SheetEvaluationOptions {
    pageId?: string;
    pageTitle?: string;
    resolveExternalReference?: (reference: SheetExternalReferenceToken) => SheetExternalReferenceResolution | null | undefined;
}
export interface SheetEvaluationCell {
    address: SheetCellAddress;
    raw: string;
    value: SheetPrimitive;
    display: string;
    type: 'empty' | 'number' | 'string' | 'boolean';
    error?: string;
    dependsOn: SheetCellAddress[];
    dependents: SheetCellAddress[];
}
export interface SheetEvaluation {
    byAddress: Record<SheetCellAddress, SheetEvaluationCell>;
    display: string[][];
    errors: (string | null)[][];
    dependencies: Record<SheetCellAddress, SheetDocDependencyRecord>;
}
export declare function createEmptySheet(rows?: number, columns?: number): SheetData;
export declare function parseSheetContent(content: unknown): SheetData;
export declare function serializeSheetContent(sheet: SheetData, options?: {
    pageId?: string;
    sheetName?: string;
}): string;
export declare function parseSheetDocString(value: string): SheetDoc;
export declare function stringifySheetDoc(doc: SheetDoc): string;
export declare function encodeCellAddress(rowIndex: number, columnIndex: number): SheetCellAddress;
export declare function decodeCellAddress(address: SheetCellAddress): {
    row: number;
    column: number;
};
export declare function evaluateSheet(sheet: SheetData, options?: SheetEvaluationOptions): SheetEvaluation;
export declare function collectExternalReferences(sheet: SheetData): SheetExternalReferenceToken[];
export declare function sanitizeSheetData(sheet: SheetData): SheetData;
export declare function isSheetType(type: PageType): boolean;
//# sourceMappingURL=sheet.d.ts.map