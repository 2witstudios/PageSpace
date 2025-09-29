"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHEETDOC_VERSION = exports.SHEETDOC_MAGIC = exports.SHEET_DEFAULT_COLUMNS = exports.SHEET_DEFAULT_ROWS = exports.SHEET_VERSION = void 0;
exports.createEmptySheet = createEmptySheet;
exports.parseSheetContent = parseSheetContent;
exports.serializeSheetContent = serializeSheetContent;
exports.parseSheetDocString = parseSheetDocString;
exports.stringifySheetDoc = stringifySheetDoc;
exports.encodeCellAddress = encodeCellAddress;
exports.decodeCellAddress = decodeCellAddress;
exports.evaluateSheet = evaluateSheet;
exports.collectExternalReferences = collectExternalReferences;
exports.sanitizeSheetData = sanitizeSheetData;
exports.isSheetType = isSheetType;
const toml_1 = require("@iarna/toml");
const enums_1 = require("./enums");
exports.SHEET_VERSION = 1;
exports.SHEET_DEFAULT_ROWS = 20;
exports.SHEET_DEFAULT_COLUMNS = 10;
exports.SHEETDOC_MAGIC = '#%PAGESPACE_SHEETDOC';
exports.SHEETDOC_VERSION = 'v1';
const numberRegex = /^-?(?:\d+\.?\d*|\.\d+)$/;
const cellRegex = /^[A-Z]+\d+$/;
const externalReferenceRegex = /^@\[(?<label>[^\]]+)\](?:\((?<identifier>[^):]+)(?::(?<mentionType>[^)]+))?\))?:(?<address>[A-Z]+\d+)$/i;
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function cloneCells(cells) {
    return { ...cells };
}
function createEmptySheet(rows = exports.SHEET_DEFAULT_ROWS, columns = exports.SHEET_DEFAULT_COLUMNS) {
    return {
        version: exports.SHEET_VERSION,
        rowCount: Math.max(1, Math.floor(rows)),
        columnCount: Math.max(1, Math.floor(columns)),
        cells: {},
    };
}
function parseSheetContent(content) {
    if (!content) {
        return createEmptySheet();
    }
    if (typeof content === 'string') {
        const trimmed = content.trim();
        if (!trimmed) {
            return createEmptySheet();
        }
        if (isSheetDocString(trimmed)) {
            try {
                const doc = parseSheetDocString(trimmed);
                return sheetDataFromSheetDoc(doc);
            }
            catch {
                return createEmptySheet();
            }
        }
        try {
            const parsed = JSON.parse(trimmed);
            return parseSheetContent(parsed);
        }
        catch {
            return createEmptySheet();
        }
    }
    if (isSheetDocObject(content)) {
        try {
            return sheetDataFromSheetDoc(normalizeSheetDocObject(content));
        }
        catch {
            return createEmptySheet();
        }
    }
    if (!isObject(content)) {
        return createEmptySheet();
    }
    const version = typeof content.version === 'number' ? content.version : exports.SHEET_VERSION;
    const rowCount = typeof content.rowCount === 'number' && Number.isFinite(content.rowCount)
        ? Math.max(1, Math.floor(content.rowCount))
        : exports.SHEET_DEFAULT_ROWS;
    const columnCount = typeof content.columnCount === 'number' && Number.isFinite(content.columnCount)
        ? Math.max(1, Math.floor(content.columnCount))
        : exports.SHEET_DEFAULT_COLUMNS;
    const cells = {};
    if (isObject(content.cells)) {
        for (const [key, value] of Object.entries(content.cells)) {
            if (typeof value === 'string') {
                cells[key.toUpperCase()] = value;
            }
            else if (value !== null && value !== undefined) {
                cells[key.toUpperCase()] = String(value);
            }
        }
    }
    return {
        version,
        rowCount,
        columnCount,
        cells,
    };
}
function serializeSheetContent(sheet, options = {}) {
    const sanitized = sanitizeSheetData({ ...sheet });
    const evaluation = evaluateSheet(sanitized);
    const doc = sheetDataToSheetDoc(sanitized, evaluation, options);
    return stringifySheetDoc(doc);
}
function isSheetDocString(value) {
    return value.trimStart().startsWith(exports.SHEETDOC_MAGIC);
}
function parseSheetDocString(value) {
    const lines = value.split(/\r?\n/);
    let headerIndex = -1;
    for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim()) {
            headerIndex = index;
            break;
        }
    }
    if (headerIndex === -1) {
        throw new Error('Missing SheetDoc header');
    }
    const headerLine = lines[headerIndex].trim();
    if (!headerLine.startsWith(exports.SHEETDOC_MAGIC)) {
        throw new Error('Invalid SheetDoc header');
    }
    const versionPart = headerLine.slice(exports.SHEETDOC_MAGIC.length).trim();
    if (versionPart && versionPart !== exports.SHEETDOC_VERSION) {
        throw new Error(`Unsupported SheetDoc version: ${versionPart}`);
    }
    const tomlSource = lines.slice(headerIndex + 1).join('\n');
    const parsed = tomlSource.trim() ? (0, toml_1.parse)(tomlSource) : {};
    return normalizeSheetDocObject(parsed);
}
function isSheetDocObject(value) {
    return isObject(value) && Array.isArray(value.sheets);
}
function normalizeSheetDocObject(value) {
    const pageId = typeof value.page_id === 'string' ? value.page_id : undefined;
    const sheetsInput = Array.isArray(value.sheets) ? value.sheets : [];
    const sheets = [];
    sheetsInput.forEach((sheetValue, index) => {
        if (!isObject(sheetValue)) {
            return;
        }
        const name = typeof sheetValue.name === 'string' ? sheetValue.name : `Sheet ${index + 1}`;
        const order = typeof sheetValue.order === 'number' && Number.isFinite(sheetValue.order)
            ? sheetValue.order
            : index;
        const metaSource = isObject(sheetValue.meta) ? sheetValue.meta : {};
        const rowCount = typeof metaSource.row_count === 'number' && Number.isFinite(metaSource.row_count)
            ? Math.max(1, Math.floor(metaSource.row_count))
            : exports.SHEET_DEFAULT_ROWS;
        const columnCount = typeof metaSource.column_count === 'number' && Number.isFinite(metaSource.column_count)
            ? Math.max(1, Math.floor(metaSource.column_count))
            : exports.SHEET_DEFAULT_COLUMNS;
        const meta = {
            rowCount,
            columnCount,
        };
        if (typeof metaSource.frozen_rows === 'number' && Number.isFinite(metaSource.frozen_rows)) {
            meta.frozenRows = Math.max(0, Math.floor(metaSource.frozen_rows));
        }
        if (typeof metaSource.frozen_columns === 'number' && Number.isFinite(metaSource.frozen_columns)) {
            meta.frozenColumns = Math.max(0, Math.floor(metaSource.frozen_columns));
        }
        for (const [metaKey, metaValue] of Object.entries(metaSource)) {
            if (['row_count', 'column_count', 'frozen_rows', 'frozen_columns'].includes(metaKey)) {
                continue;
            }
            if (typeof metaValue === 'number' ||
                typeof metaValue === 'string' ||
                typeof metaValue === 'boolean') {
                meta[toCamelCase(metaKey)] = metaValue;
            }
        }
        const columns = {};
        if (isObject(sheetValue.columns)) {
            for (const [columnKey, columnValue] of Object.entries(sheetValue.columns)) {
                if (!isObject(columnValue)) {
                    continue;
                }
                const normalized = {};
                for (const [propKey, propValue] of Object.entries(columnValue)) {
                    if (typeof propValue === 'string' ||
                        typeof propValue === 'number' ||
                        typeof propValue === 'boolean') {
                        normalized[propKey] = propValue;
                    }
                }
                if (Object.keys(normalized).length > 0) {
                    columns[columnKey.toUpperCase()] = normalized;
                }
            }
        }
        const cells = {};
        if (isObject(sheetValue.cells)) {
            for (const [addressKey, cellValue] of Object.entries(sheetValue.cells)) {
                const normalizedAddress = normalizeCellAddress(addressKey);
                if (!normalizedAddress || !isObject(cellValue)) {
                    continue;
                }
                const formula = typeof cellValue.formula === 'string' ? cellValue.formula.trim() : undefined;
                const valuePrimitive = 'value' in cellValue ? coerceSheetPrimitive(cellValue.value) : undefined;
                const typeValue = typeof cellValue.type === 'string' ? cellValue.type : undefined;
                const notesValue = Array.isArray(cellValue.notes)
                    ? cellValue.notes.filter((note) => typeof note === 'string')
                    : undefined;
                const errorValue = isObject(cellValue.error)
                    ? normalizeCellError(cellValue.error)
                    : undefined;
                const cell = {};
                if (formula) {
                    cell.formula = formula;
                }
                if (valuePrimitive !== undefined) {
                    cell.value = valuePrimitive;
                }
                if (typeValue) {
                    cell.type = typeValue;
                }
                if (notesValue && notesValue.length > 0) {
                    cell.notes = notesValue;
                }
                if (errorValue) {
                    cell.error = errorValue;
                }
                if (Object.keys(cell).length > 0) {
                    cells[normalizedAddress] = cell;
                }
            }
        }
        const ranges = {};
        if (isObject(sheetValue.ranges)) {
            for (const [rangeKey, rangeValue] of Object.entries(sheetValue.ranges)) {
                if (isObject(rangeValue)) {
                    ranges[rangeKey] = clonePlainObject(rangeValue);
                }
            }
        }
        const dependencies = {};
        if (isObject(sheetValue.dependencies)) {
            for (const [addressKey, dependencyValue] of Object.entries(sheetValue.dependencies)) {
                const normalizedAddress = normalizeCellAddress(addressKey);
                if (!normalizedAddress || !isObject(dependencyValue)) {
                    continue;
                }
                const dependsOn = Array.isArray(dependencyValue.depends_on)
                    ? dependencyValue.depends_on
                        .map((item) => typeof item === 'string' ? normalizeDependencyReference(item) : null)
                        .filter((ref) => Boolean(ref))
                    : [];
                const dependents = Array.isArray(dependencyValue.dependents)
                    ? dependencyValue.dependents
                        .map((item) => typeof item === 'string' ? normalizeDependencyReference(item) : null)
                        .filter((ref) => Boolean(ref))
                    : [];
                dependencies[normalizedAddress] = {
                    dependsOn: uniqueSorted(dependsOn),
                    dependents: uniqueSorted(dependents),
                };
            }
        }
        sheets.push({
            name,
            order,
            meta,
            columns,
            cells,
            ranges,
            dependencies,
        });
    });
    if (sheets.length === 0) {
        sheets.push({
            name: 'Sheet1',
            order: 0,
            meta: { rowCount: exports.SHEET_DEFAULT_ROWS, columnCount: exports.SHEET_DEFAULT_COLUMNS },
            columns: {},
            cells: {},
            ranges: {},
            dependencies: {},
        });
    }
    return sortSheetDoc({
        version: exports.SHEETDOC_VERSION,
        pageId,
        sheets,
    });
}
function sortSheetDoc(doc) {
    const sheets = [...doc.sheets]
        .map((sheet) => ({
        ...sheet,
        columns: sortRecord(sheet.columns, (value) => ({ ...value })),
        cells: sortRecord(sheet.cells, (cell) => normalizeCellForOutput(cell)),
        ranges: sortRecord(sheet.ranges, (range) => clonePlainObject(range)),
        dependencies: sortRecord(sheet.dependencies, (dependency) => ({
            dependsOn: uniqueSorted(dependency.dependsOn),
            dependents: uniqueSorted(dependency.dependents),
        })),
    }))
        .sort((a, b) => {
        if (a.order !== b.order) {
            return a.order - b.order;
        }
        return a.name.localeCompare(b.name);
    });
    return {
        ...doc,
        sheets,
    };
}
function sortRecord(record, mapValue) {
    const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
    const result = {};
    for (const [key, value] of entries) {
        result[key] = mapValue ? mapValue(value) : value;
    }
    return result;
}
function normalizeCellForOutput(cell) {
    const normalized = {};
    if (cell.formula !== undefined) {
        normalized.formula = cell.formula;
    }
    if (cell.value !== undefined) {
        normalized.value = cell.value;
    }
    if (cell.type !== undefined) {
        normalized.type = cell.type;
    }
    if (cell.notes && cell.notes.length > 0) {
        normalized.notes = [...cell.notes];
    }
    if (cell.error) {
        normalized.error = {
            type: cell.error.type,
            ...(cell.error.message ? { message: cell.error.message } : {}),
            ...(cell.error.details && cell.error.details.length > 0
                ? { details: [...cell.error.details] }
                : {}),
        };
    }
    return normalized;
}
function sheetDataFromSheetDoc(doc) {
    const normalized = sortSheetDoc(doc);
    const target = normalized.sheets[0];
    if (!target) {
        return createEmptySheet();
    }
    const cells = {};
    for (const [address, cell] of Object.entries(target.cells)) {
        const normalizedAddress = normalizeCellAddress(address);
        if (!normalizedAddress) {
            continue;
        }
        if (cell.formula) {
            const trimmed = cell.formula.trim();
            cells[normalizedAddress] = trimmed.startsWith('=') ? trimmed : `=${trimmed}`;
            continue;
        }
        if (cell.value !== undefined) {
            cells[normalizedAddress] = formatPrimitiveForCell(cell.value);
            continue;
        }
    }
    return {
        version: exports.SHEET_VERSION,
        rowCount: Math.max(1, Math.floor(target.meta.rowCount)),
        columnCount: Math.max(1, Math.floor(target.meta.columnCount)),
        cells,
    };
}
function sheetDataToSheetDoc(sheet, evaluation, options) {
    const sheetName = options.sheetName ?? 'Sheet1';
    const cells = {};
    const dependencies = {};
    const addresses = Object.keys(evaluation.byAddress).sort((a, b) => a.localeCompare(b));
    for (const address of addresses) {
        const evalCell = evaluation.byAddress[address];
        const raw = sheet.cells[address] ?? '';
        const trimmed = raw.trim();
        const docCell = {};
        if (trimmed.startsWith('=')) {
            docCell.formula = trimmed;
            docCell.value = evalCell.error ? '' : evalCell.value;
        }
        else if (trimmed !== '') {
            docCell.value = evalCell.value;
        }
        if (evalCell.type !== 'empty') {
            docCell.type = evalCell.type;
        }
        if (evalCell.error) {
            const errorType = evalCell.error.includes('Circular') ? 'CIRCULAR_REF' : 'EVAL_ERROR';
            const error = {
                type: errorType,
                message: evalCell.error,
            };
            if (errorType === 'CIRCULAR_REF') {
                error.details = uniqueSorted([address, ...evalCell.dependsOn]);
            }
            docCell.error = error;
        }
        if (docCell.formula !== undefined || docCell.value !== undefined || docCell.type || docCell.error) {
            cells[address] = docCell;
        }
        if (evalCell.dependsOn.length > 0 || evalCell.dependents.length > 0) {
            dependencies[address] = {
                dependsOn: uniqueSorted(evalCell.dependsOn),
                dependents: uniqueSorted(evalCell.dependents),
            };
        }
    }
    return sortSheetDoc({
        version: exports.SHEETDOC_VERSION,
        pageId: options.pageId,
        sheets: [
            {
                name: sheetName,
                order: 0,
                meta: {
                    rowCount: Math.max(1, Math.floor(sheet.rowCount)),
                    columnCount: Math.max(1, Math.floor(sheet.columnCount)),
                },
                columns: {},
                cells,
                ranges: {},
                dependencies,
            },
        ],
    });
}
function stringifySheetDoc(doc) {
    const normalized = sortSheetDoc(doc);
    const lines = [`${exports.SHEETDOC_MAGIC} ${exports.SHEETDOC_VERSION}`];
    if (normalized.pageId) {
        lines.push(`page_id = ${formatTomlString(normalized.pageId)}`);
    }
    for (const sheet of normalized.sheets) {
        lines.push('');
        lines.push('[[sheets]]');
        lines.push(`name = ${formatTomlString(sheet.name)}`);
        lines.push(`order = ${sheet.order}`);
        lines.push('');
        lines.push('[sheets.meta]');
        lines.push(`row_count = ${sheet.meta.rowCount}`);
        lines.push(`column_count = ${sheet.meta.columnCount}`);
        if (typeof sheet.meta.frozenRows === 'number') {
            lines.push(`frozen_rows = ${sheet.meta.frozenRows}`);
        }
        if (typeof sheet.meta.frozenColumns === 'number') {
            lines.push(`frozen_columns = ${sheet.meta.frozenColumns}`);
        }
        for (const [metaKey, metaValue] of Object.entries(sheet.meta)) {
            if (['rowCount', 'columnCount', 'frozenRows', 'frozenColumns'].includes(metaKey)) {
                continue;
            }
            if (metaValue === undefined) {
                continue;
            }
            lines.push(`${toSnakeCase(metaKey)} = ${formatTomlValue(metaValue)}`);
        }
        if (Object.keys(sheet.columns).length > 0) {
            lines.push('');
            lines.push('[sheets.columns]');
            for (const [columnKey, columnValue] of Object.entries(sheet.columns)) {
                lines.push(`${columnKey} = ${formatInlineTable(columnValue)}`);
            }
        }
        for (const [address, cell] of Object.entries(sheet.cells)) {
            lines.push('');
            lines.push(`[sheets.cells.${address}]`);
            if (cell.formula !== undefined) {
                lines.push(`formula = ${formatTomlString(cell.formula)}`);
            }
            if (cell.value !== undefined) {
                lines.push(`value = ${formatTomlValue(cell.value)}`);
            }
            if (cell.type !== undefined) {
                lines.push(`type = ${formatTomlString(cell.type)}`);
            }
            if (cell.notes && cell.notes.length > 0) {
                lines.push(`notes = ${formatTomlValue(cell.notes)}`);
            }
            if (cell.error) {
                const errorRecord = {
                    type: cell.error.type,
                    ...(cell.error.message ? { message: cell.error.message } : {}),
                    ...(cell.error.details ? { details: cell.error.details } : {}),
                };
                lines.push(`error = ${formatInlineTable(errorRecord)}`);
            }
        }
        if (Object.keys(sheet.ranges).length > 0) {
            for (const [rangeKey, rangeValue] of Object.entries(sheet.ranges)) {
                lines.push('');
                lines.push(`[sheets.ranges.${rangeKey}]`);
                for (const [rangePropKey, rangePropValue] of Object.entries(rangeValue)) {
                    lines.push(`${rangePropKey} = ${formatTomlValue(rangePropValue)}`);
                }
            }
        }
        if (Object.keys(sheet.dependencies).length > 0) {
            for (const [address, dependency] of Object.entries(sheet.dependencies)) {
                lines.push('');
                lines.push(`[sheets.dependencies.${address}]`);
                lines.push(`depends_on = ${formatTomlValue(dependency.dependsOn)}`);
                lines.push(`dependents = ${formatTomlValue(dependency.dependents)}`);
            }
        }
    }
    lines.push('');
    return lines.join('\n');
}
function formatPrimitiveForCell(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : '';
    }
    if (typeof value === 'boolean') {
        return value ? 'TRUE' : 'FALSE';
    }
    if (typeof value === 'string') {
        return value;
    }
    return '';
}
function formatTomlString(value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/\"/g, '\\"')}"`;
}
function formatTomlValue(value) {
    if (value === null || value === undefined) {
        return formatTomlString('');
    }
    if (typeof value === 'string') {
        return formatTomlString(value);
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : '0';
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (Array.isArray(value)) {
        const parts = value.map((item) => formatTomlValue(item));
        return `[${parts.join(', ')}]`;
    }
    if (isObject(value)) {
        return formatInlineTable(value);
    }
    return formatTomlString(String(value));
}
function formatInlineTable(record) {
    const entries = Object.entries(record).filter(([, entryValue]) => entryValue !== undefined);
    const parts = entries.map(([key, entryValue]) => `${key} = ${formatTomlValue(entryValue)}`);
    if (parts.length === 0) {
        return '{}';
    }
    return `{ ${parts.join(', ')} }`;
}
function clonePlainObject(value) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (Array.isArray(entry)) {
            result[key] = entry.map((item) => isObject(item) ? clonePlainObject(item) : item);
            continue;
        }
        if (isObject(entry)) {
            result[key] = clonePlainObject(entry);
            continue;
        }
        if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
            result[key] = entry;
        }
    }
    return result;
}
function uniqueSorted(values) {
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
function normalizeCellAddress(address) {
    if (!address) {
        return null;
    }
    const upper = address.trim().toUpperCase();
    return cellRegex.test(upper) ? upper : null;
}
function normalizeDependencyReference(reference) {
    if (!reference) {
        return null;
    }
    const trimmed = reference.trim();
    if (!trimmed) {
        return null;
    }
    const upper = trimmed.toUpperCase();
    if (cellRegex.test(upper)) {
        return upper;
    }
    const match = trimmed.match(externalReferenceRegex);
    if (!match || !match.groups) {
        return null;
    }
    const label = (match.groups.label ?? '').trim();
    if (!label) {
        return null;
    }
    const identifier = match.groups.identifier ? match.groups.identifier.trim() : undefined;
    const mentionType = match.groups.mentionType ? match.groups.mentionType.trim() : undefined;
    const address = match.groups.address ? match.groups.address.toUpperCase() : undefined;
    if (!address || !cellRegex.test(address)) {
        return null;
    }
    const idPart = identifier ? `(${identifier}${mentionType ? `:${mentionType}` : ''})` : '';
    return `@[${label}]${idPart}:${address}`;
}
function formatExternalReference(page, address) {
    const normalizedAddress = address.toUpperCase();
    const label = page.label.trim();
    const identifier = page.identifier?.trim();
    const mentionType = page.mentionType?.trim();
    const idPart = identifier ? `(${identifier}${mentionType ? `:${mentionType}` : ''})` : '';
    return `@[${label}]${idPart}:${normalizedAddress}`;
}
function toCamelCase(value) {
    return value.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}
function toSnakeCase(value) {
    return value.replace(/([A-Z])/g, '_$1').toLowerCase();
}
function coerceSheetPrimitive(value) {
    if (value === undefined) {
        return undefined;
    }
    if (value === null) {
        return '';
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return value;
    }
    return undefined;
}
function normalizeCellError(value) {
    const type = typeof value.type === 'string' ? value.type : undefined;
    const message = typeof value.message === 'string' ? value.message : undefined;
    const details = Array.isArray(value.details)
        ? value.details.filter((entry) => typeof entry === 'string')
        : undefined;
    if (!type && !message && (!details || details.length === 0)) {
        return undefined;
    }
    const error = {
        type: type ?? 'EVAL_ERROR',
    };
    if (message) {
        error.message = message;
    }
    if (details && details.length > 0) {
        error.details = uniqueSorted(details);
    }
    return error;
}
function encodeCellAddress(rowIndex, columnIndex) {
    if (rowIndex < 0 || columnIndex < 0) {
        throw new Error('Row and column indices must be non-negative');
    }
    let column = '';
    let index = columnIndex;
    while (index >= 0) {
        column = String.fromCharCode((index % 26) + 65) + column;
        index = Math.floor(index / 26) - 1;
    }
    return `${column}${rowIndex + 1}`;
}
function decodeCellAddress(address) {
    const match = address.toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!match) {
        throw new Error(`Invalid cell reference: ${address}`);
    }
    const [, columnLetters, rowPart] = match;
    let column = 0;
    for (let i = 0; i < columnLetters.length; i++) {
        column *= 26;
        column += columnLetters.charCodeAt(i) - 64;
    }
    return {
        row: parseInt(rowPart, 10) - 1,
        column: column - 1,
    };
}
function tokenize(formula) {
    const tokens = [];
    let index = 0;
    while (index < formula.length) {
        const char = formula[index];
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        if (char === '@' && formula[index + 1] === '[') {
            let end = index + 2;
            let label = '';
            while (end < formula.length && formula[end] !== ']') {
                label += formula[end];
                end += 1;
            }
            if (end >= formula.length) {
                throw new Error('Unterminated page reference');
            }
            const trimmedLabel = label.trim();
            if (!trimmedLabel) {
                throw new Error('Page reference label cannot be empty');
            }
            let cursor = end + 1;
            let identifier;
            let mentionType;
            let rawSuffix = '';
            if (formula[cursor] === '(') {
                cursor += 1;
                let metaEnd = cursor;
                while (metaEnd < formula.length && formula[metaEnd] !== ')') {
                    metaEnd += 1;
                }
                if (metaEnd >= formula.length) {
                    throw new Error('Unterminated page reference identifier');
                }
                const metaContent = formula.slice(cursor, metaEnd).trim();
                rawSuffix = metaContent ? `(${metaContent})` : '';
                if (metaContent) {
                    const colonIndex = metaContent.indexOf(':');
                    if (colonIndex === -1) {
                        identifier = metaContent.trim();
                    }
                    else {
                        identifier = metaContent.slice(0, colonIndex).trim();
                        const typePart = metaContent.slice(colonIndex + 1).trim();
                        if (typePart) {
                            mentionType = typePart;
                        }
                    }
                }
                cursor = metaEnd + 1;
            }
            const rawMention = `@[${trimmedLabel}]${rawSuffix}`;
            const pageMeta = {
                raw: rawMention,
                label: trimmedLabel,
                normalizedLabel: trimmedLabel.toLowerCase(),
                identifier: identifier && identifier.length > 0 ? identifier : undefined,
                mentionType: mentionType,
            };
            tokens.push({ type: 'page', value: rawMention, meta: { page: pageMeta } });
            index = cursor;
            continue;
        }
        if (char === '"') {
            let end = index + 1;
            let value = '';
            while (end < formula.length && formula[end] !== '"') {
                value += formula[end];
                end += 1;
            }
            if (end >= formula.length) {
                throw new Error('Unterminated string literal');
            }
            tokens.push({ type: 'string', value });
            index = end + 1;
            continue;
        }
        if (/[0-9.]/.test(char)) {
            let end = index + 1;
            while (end < formula.length && /[0-9.]/.test(formula[end])) {
                end += 1;
            }
            const value = formula.slice(index, end);
            if (!numberRegex.test(value)) {
                throw new Error(`Invalid number literal: ${value}`);
            }
            tokens.push({ type: 'number', value });
            index = end;
            continue;
        }
        if (/[A-Za-z_]/.test(char)) {
            let end = index + 1;
            while (end < formula.length && /[A-Za-z0-9_]/.test(formula[end])) {
                end += 1;
            }
            const raw = formula.slice(index, end);
            const upper = raw.toUpperCase();
            if (cellRegex.test(upper)) {
                tokens.push({ type: 'cell', value: upper });
            }
            else {
                tokens.push({ type: 'identifier', value: upper });
            }
            index = end;
            continue;
        }
        if (char === '(' || char === ')') {
            tokens.push({ type: 'paren', value: char });
            index += 1;
            continue;
        }
        if (char === ',') {
            tokens.push({ type: 'comma', value: char });
            index += 1;
            continue;
        }
        if (char === ':') {
            tokens.push({ type: 'colon', value: char });
            index += 1;
            continue;
        }
        if (char === '<' || char === '>' || char === '=') {
            const next = formula[index + 1];
            if (char === '<' && next === '=') {
                tokens.push({ type: 'operator', value: '<=' });
                index += 2;
                continue;
            }
            if (char === '>' && next === '=') {
                tokens.push({ type: 'operator', value: '>=' });
                index += 2;
                continue;
            }
            if (char === '<' && next === '>') {
                tokens.push({ type: 'operator', value: '<>' });
                index += 2;
                continue;
            }
            tokens.push({ type: 'operator', value: char });
            index += 1;
            continue;
        }
        if (char === '+' || char === '-' || char === '*' || char === '/' || char === '^' || char === '&') {
            tokens.push({ type: 'operator', value: char });
            index += 1;
            continue;
        }
        throw new Error(`Unexpected character '${char}' in formula`);
    }
    return tokens;
}
class FormulaParser {
    tokens;
    position = 0;
    constructor(tokens) {
        this.tokens = tokens;
    }
    parse() {
        const expression = this.parseComparison();
        if (!this.isAtEnd()) {
            throw new Error('Unexpected tokens after end of formula');
        }
        return expression;
    }
    parseComparison() {
        let node = this.parseConcatenation();
        while (this.matchOperator('=', '>', '<', '>=', '<=', '<>')) {
            const operator = this.previous().value;
            const right = this.parseConcatenation();
            node = {
                type: 'BinaryExpression',
                operator,
                left: node,
                right,
            };
        }
        return node;
    }
    parseConcatenation() {
        let node = this.parseAddition();
        while (this.matchOperator('&')) {
            const operator = this.previous().value;
            const right = this.parseAddition();
            node = {
                type: 'BinaryExpression',
                operator,
                left: node,
                right,
            };
        }
        return node;
    }
    parseAddition() {
        let node = this.parseMultiplication();
        while (this.matchOperator('+', '-')) {
            const operator = this.previous().value;
            const right = this.parseMultiplication();
            node = {
                type: 'BinaryExpression',
                operator,
                left: node,
                right,
            };
        }
        return node;
    }
    parseMultiplication() {
        let node = this.parseExponent();
        while (this.matchOperator('*', '/')) {
            const operator = this.previous().value;
            const right = this.parseExponent();
            node = {
                type: 'BinaryExpression',
                operator,
                left: node,
                right,
            };
        }
        return node;
    }
    parseExponent() {
        let node = this.parseUnary();
        while (this.matchOperator('^')) {
            const operator = this.previous().value;
            const right = this.parseUnary();
            node = {
                type: 'BinaryExpression',
                operator,
                left: node,
                right,
            };
        }
        return node;
    }
    parseUnary() {
        if (this.matchOperator('+', '-')) {
            const operator = this.previous().value;
            const argument = this.parseUnary();
            return {
                type: 'UnaryExpression',
                operator,
                argument,
            };
        }
        return this.parseRange();
    }
    parseRange() {
        const left = this.parsePrimary();
        if (this.match('colon')) {
            const right = this.parsePrimary();
            if (left.type !== 'CellReference' || right.type !== 'CellReference') {
                throw new Error('Range references must use cell addresses');
            }
            return {
                type: 'Range',
                start: left,
                end: right,
            };
        }
        return left;
    }
    parsePrimary() {
        if (this.match('number')) {
            return {
                type: 'NumberLiteral',
                value: Number(this.previous().value),
            };
        }
        if (this.match('string')) {
            return {
                type: 'StringLiteral',
                value: this.previous().value,
            };
        }
        if (this.match('page')) {
            const token = this.previous();
            const meta = token.meta?.page;
            if (!meta) {
                throw new Error('Invalid page reference');
            }
            this.consume('colon', ':', 'Expected ":" after page reference');
            const start = this.parseCellReference();
            if (this.match('colon')) {
                const end = this.parseCellReference();
                return {
                    type: 'ExternalRange',
                    page: meta,
                    start,
                    end,
                };
            }
            return {
                type: 'ExternalCellReference',
                page: meta,
                reference: start.reference,
            };
        }
        if (this.match('cell')) {
            return {
                type: 'CellReference',
                reference: this.previous().value,
            };
        }
        if (this.match('identifier')) {
            const name = this.previous().value;
            if (!this.matchSpecific('paren', '(')) {
                throw new Error(`Unexpected identifier '${name}'`);
            }
            const args = [];
            if (!this.check('paren', ')')) {
                do {
                    args.push(this.parseComparison());
                } while (this.match('comma'));
            }
            this.consume('paren', ')', `Expected closing parenthesis for ${name}()`);
            return {
                type: 'FunctionCall',
                name,
                args,
            };
        }
        if (this.matchSpecific('paren', '(')) {
            const expr = this.parseComparison();
            this.consume('paren', ')', 'Expected closing parenthesis');
            return expr;
        }
        throw new Error('Unexpected end of formula');
    }
    match(...types) {
        for (const type of types) {
            if (this.check(type)) {
                this.advance();
                return true;
            }
        }
        return false;
    }
    matchSpecific(type, value) {
        if (this.check(type, value)) {
            this.advance();
            return true;
        }
        return false;
    }
    matchOperator(...operators) {
        if (!this.check('operator')) {
            return false;
        }
        const token = this.peek();
        if (operators.includes(token.value)) {
            this.advance();
            return true;
        }
        return false;
    }
    consume(type, value, message) {
        if (this.check(type, value)) {
            return this.advance();
        }
        throw new Error(message);
    }
    check(type, value) {
        if (this.isAtEnd()) {
            return false;
        }
        const token = this.peek();
        if (token.type !== type) {
            return false;
        }
        if (value !== undefined) {
            return token.value === value;
        }
        return true;
    }
    advance() {
        if (!this.isAtEnd()) {
            this.position += 1;
        }
        return this.previous();
    }
    isAtEnd() {
        return this.position >= this.tokens.length;
    }
    peek() {
        return this.tokens[this.position];
    }
    previous() {
        return this.tokens[this.position - 1];
    }
    parseCellReference() {
        if (this.match('cell')) {
            return {
                type: 'CellReference',
                reference: this.previous().value,
            };
        }
        throw new Error('Expected cell reference after page reference');
    }
}
function formatDisplayValue(value) {
    if (value === '') {
        return '';
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return '#ERROR';
        }
        const stringValue = value.toString();
        return stringValue.length > 12 ? value.toPrecision(12).replace(/0+$/g, '').replace(/\.$/, '') : stringValue;
    }
    if (typeof value === 'boolean') {
        return value ? 'TRUE' : 'FALSE';
    }
    return value;
}
function expandRange(start, end) {
    const { row: startRow, column: startColumn } = decodeCellAddress(start);
    const { row: endRow, column: endColumn } = decodeCellAddress(end);
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startColumn, endColumn);
    const maxCol = Math.max(startColumn, endColumn);
    const addresses = [];
    for (let row = minRow; row <= maxRow; row++) {
        for (let column = minCol; column <= maxCol; column++) {
            addresses.push(encodeCellAddress(row, column));
        }
    }
    return addresses;
}
function coerceNumber(value) {
    if (value === '') {
        return 0;
    }
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return 0;
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
        throw new Error('Expected a numeric value');
    }
    return parsed;
}
function toBoolean(value) {
    if (value === '') {
        return false;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return false;
    }
    const normalized = trimmed.toUpperCase();
    if (normalized === 'TRUE') {
        return true;
    }
    if (normalized === 'FALSE') {
        return false;
    }
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
        return numeric !== 0;
    }
    return true;
}
function flattenValue(value) {
    if (Array.isArray(value)) {
        return value.flatMap((item) => flattenValue(item));
    }
    return [value];
}
function evaluateFunction(name, args, evaluateNode) {
    const upperName = name.toUpperCase();
    const values = args.flatMap((arg) => flattenValue(evaluateNode(arg)));
    switch (upperName) {
        case 'SUM': {
            return values.reduce((total, value) => total + coerceNumber(value), 0);
        }
        case 'AVERAGE':
        case 'AVG': {
            const numericValues = values.filter((value) => {
                try {
                    coerceNumber(value);
                    return true;
                }
                catch {
                    return false;
                }
            });
            if (numericValues.length === 0) {
                return 0;
            }
            const sum = numericValues.reduce((total, value) => total + coerceNumber(value), 0);
            return sum / numericValues.length;
        }
        case 'MIN': {
            const numericValues = values.map((value) => coerceNumber(value));
            return numericValues.length ? Math.min(...numericValues) : 0;
        }
        case 'MAX': {
            const numericValues = values.map((value) => coerceNumber(value));
            return numericValues.length ? Math.max(...numericValues) : 0;
        }
        case 'COUNT': {
            return values.reduce((count, value) => {
                if (value === '' || value === null || value === undefined) {
                    return count;
                }
                if (typeof value === 'number') {
                    return count + 1;
                }
                if (typeof value === 'boolean') {
                    return count + 1;
                }
                const numeric = Number(value);
                return Number.isNaN(numeric) ? count : count + 1;
            }, 0);
        }
        case 'COUNTA': {
            return values.reduce((count, value) => (value === '' ? count : count + 1), 0);
        }
        case 'ABS': {
            if (values.length !== 1) {
                throw new Error('ABS expects exactly one argument');
            }
            return Math.abs(coerceNumber(values[0]));
        }
        case 'ROUND': {
            if (values.length === 0) {
                throw new Error('ROUND expects at least one argument');
            }
            const value = coerceNumber(values[0]);
            const precision = values.length > 1 ? coerceNumber(values[1]) : 0;
            const factor = Math.pow(10, precision);
            return Math.round(value * factor) / factor;
        }
        case 'FLOOR': {
            if (values.length === 0) {
                throw new Error('FLOOR expects at least one argument');
            }
            const value = coerceNumber(values[0]);
            const significance = values.length > 1 ? Math.abs(coerceNumber(values[1])) : 1;
            if (significance === 0) {
                throw new Error('FLOOR significance cannot be zero');
            }
            return Math.floor(value / significance) * significance;
        }
        case 'CEILING': {
            if (values.length === 0) {
                throw new Error('CEILING expects at least one argument');
            }
            const value = coerceNumber(values[0]);
            const significance = values.length > 1 ? Math.abs(coerceNumber(values[1])) : 1;
            if (significance === 0) {
                throw new Error('CEILING significance cannot be zero');
            }
            return Math.ceil(value / significance) * significance;
        }
        case 'IF': {
            if (args.length < 2) {
                throw new Error('IF expects at least two arguments');
            }
            const conditionValue = flattenValue(evaluateNode(args[0]))[0];
            const condition = toBoolean(conditionValue);
            if (condition) {
                return flattenValue(evaluateNode(args[1]))[0];
            }
            if (args.length >= 3) {
                return flattenValue(evaluateNode(args[2]))[0];
            }
            return '';
        }
        default:
            throw new Error(`Unsupported function ${upperName}`);
    }
}
function collectDependencies(node) {
    const references = new Set();
    const visit = (current) => {
        switch (current.type) {
            case 'CellReference': {
                const normalized = normalizeDependencyReference(current.reference);
                if (normalized) {
                    references.add(normalized);
                }
                break;
            }
            case 'Range': {
                const expanded = expandRange(current.start.reference, current.end.reference);
                for (const address of expanded) {
                    const normalized = normalizeDependencyReference(address);
                    if (normalized) {
                        references.add(normalized);
                    }
                }
                break;
            }
            case 'ExternalCellReference': {
                const formatted = formatExternalReference(current.page, current.reference);
                const normalized = normalizeDependencyReference(formatted);
                if (normalized) {
                    references.add(normalized);
                }
                break;
            }
            case 'ExternalRange': {
                const expanded = expandRange(current.start.reference, current.end.reference);
                for (const address of expanded) {
                    const formatted = formatExternalReference(current.page, address);
                    const normalized = normalizeDependencyReference(formatted);
                    if (normalized) {
                        references.add(normalized);
                    }
                }
                break;
            }
            case 'UnaryExpression': {
                visit(current.argument);
                break;
            }
            case 'BinaryExpression': {
                visit(current.left);
                visit(current.right);
                break;
            }
            case 'FunctionCall': {
                for (const arg of current.args) {
                    visit(arg);
                }
                break;
            }
            default:
                break;
        }
    };
    visit(node);
    return Array.from(references);
}
function evaluateNode(node, context, ancestors) {
    switch (node.type) {
        case 'NumberLiteral':
            return node.value;
        case 'StringLiteral':
            return node.value;
        case 'CellReference': {
            const cell = context.getCell(node.reference, ancestors);
            if (cell.error) {
                throw new Error(cell.error);
            }
            return cell.value;
        }
        case 'Range': {
            const addresses = expandRange(node.start.reference, node.end.reference);
            return addresses.map((address) => {
                const cell = context.getCell(address, ancestors);
                if (cell.error) {
                    throw new Error(cell.error);
                }
                return cell.value;
            });
        }
        case 'ExternalCellReference': {
            const cell = context.getExternalCell(node.page, node.reference, ancestors);
            if (cell.error) {
                throw new Error(cell.error);
            }
            return cell.value;
        }
        case 'ExternalRange': {
            const addresses = expandRange(node.start.reference, node.end.reference);
            return addresses.map((address) => {
                const cell = context.getExternalCell(node.page, address, ancestors);
                if (cell.error) {
                    throw new Error(cell.error);
                }
                return cell.value;
            });
        }
        case 'UnaryExpression': {
            const argument = evaluateNode(node.argument, context, ancestors);
            const value = flattenValue(argument)[0];
            const numeric = coerceNumber(value);
            return node.operator === '-' ? -numeric : numeric;
        }
        case 'BinaryExpression': {
            const leftValue = flattenValue(evaluateNode(node.left, context, ancestors))[0];
            const rightValue = flattenValue(evaluateNode(node.right, context, ancestors))[0];
            switch (node.operator) {
                case '+': {
                    try {
                        const numericLeft = coerceNumber(leftValue);
                        const numericRight = coerceNumber(rightValue);
                        return numericLeft + numericRight;
                    }
                    catch {
                        return `${formatDisplayValue(leftValue)}${formatDisplayValue(rightValue)}`;
                    }
                }
                case '-':
                    return coerceNumber(leftValue) - coerceNumber(rightValue);
                case '*':
                    return coerceNumber(leftValue) * coerceNumber(rightValue);
                case '/': {
                    const denominator = coerceNumber(rightValue);
                    if (denominator === 0) {
                        throw new Error('Division by zero');
                    }
                    return coerceNumber(leftValue) / denominator;
                }
                case '^':
                    return Math.pow(coerceNumber(leftValue), coerceNumber(rightValue));
                case '&':
                    return `${formatDisplayValue(leftValue)}${formatDisplayValue(rightValue)}`;
                case '=': {
                    try {
                        return coerceNumber(leftValue) === coerceNumber(rightValue);
                    }
                    catch {
                        return formatDisplayValue(leftValue) === formatDisplayValue(rightValue);
                    }
                }
                case '>':
                    return coerceNumber(leftValue) > coerceNumber(rightValue);
                case '<':
                    return coerceNumber(leftValue) < coerceNumber(rightValue);
                case '>=':
                    return coerceNumber(leftValue) >= coerceNumber(rightValue);
                case '<=':
                    return coerceNumber(leftValue) <= coerceNumber(rightValue);
                case '<>': {
                    try {
                        return coerceNumber(leftValue) !== coerceNumber(rightValue);
                    }
                    catch {
                        return formatDisplayValue(leftValue) !== formatDisplayValue(rightValue);
                    }
                }
                default:
                    throw new Error('Unsupported operator');
            }
        }
        case 'FunctionCall': {
            return evaluateFunction(node.name, node.args, (child) => evaluateNode(child, context, ancestors));
        }
        default:
            throw new Error('Unsupported expression');
    }
}
const LOCAL_PAGE_KEY = '__LOCAL_PAGE__';
function getPageCache(env, pageKey) {
    let cache = env.caches.get(pageKey);
    if (!cache) {
        cache = new Map();
        env.caches.set(pageKey, cache);
    }
    return cache;
}
function getSheetForPage(env, pageKey) {
    const sheet = env.sheets.get(pageKey);
    if (!sheet) {
        throw new Error(`Missing sheet data for page ${pageKey}`);
    }
    return sheet;
}
function formatAncestorKey(pageKey, address) {
    return `${pageKey}|${address}`;
}
function resolveExternalSheet(page, env) {
    if (env.resolutionCache.has(page.raw)) {
        return env.resolutionCache.get(page.raw);
    }
    if (!env.options.resolveExternalReference) {
        const fallback = {
            pageId: page.identifier ?? page.raw,
            pageTitle: page.label,
            error: 'Cross-page references are not supported in this context',
        };
        env.resolutionCache.set(page.raw, fallback);
        return fallback;
    }
    const provided = env.options.resolveExternalReference(page);
    if (!provided) {
        const fallback = {
            pageId: page.identifier ?? page.raw,
            pageTitle: page.label,
            error: `Referenced page "${page.label}" is not available`,
        };
        env.resolutionCache.set(page.raw, fallback);
        return fallback;
    }
    const normalized = {
        pageId: provided.pageId || page.identifier || page.raw,
        pageTitle: provided.pageTitle || page.label,
        sheet: provided.sheet,
        error: provided.error,
    };
    env.resolutionCache.set(page.raw, normalized);
    if (normalized.sheet) {
        env.sheets.set(normalized.pageId, normalized.sheet);
        if (!env.caches.has(normalized.pageId)) {
            env.caches.set(normalized.pageId, new Map());
        }
        if (!env.pageTitles.has(normalized.pageId)) {
            env.pageTitles.set(normalized.pageId, normalized.pageTitle);
        }
    }
    return normalized;
}
function evaluateExternalReferenceCell(page, address, env, ancestors) {
    const resolution = resolveExternalSheet(page, env);
    if (!resolution.sheet || resolution.error) {
        return {
            address: address.toUpperCase(),
            raw: '',
            value: '',
            display: '#ERROR',
            type: 'empty',
            error: resolution.error ?? `Referenced page "${page.label}" is not available`,
            dependsOn: [],
            dependents: [],
        };
    }
    return evaluateCellInternal(address, resolution.pageId, env, ancestors);
}
function evaluateCellInternal(address, pageKey, env, ancestors) {
    const normalized = address.toUpperCase();
    const cache = getPageCache(env, pageKey);
    if (cache.has(normalized)) {
        return cache.get(normalized);
    }
    const ancestorKey = formatAncestorKey(pageKey, normalized);
    if (ancestors.has(ancestorKey)) {
        const sheet = getSheetForPage(env, pageKey);
        const circular = {
            address: normalized,
            raw: sheet.cells[normalized] ?? '',
            value: '',
            display: '#CYCLE',
            type: 'empty',
            error: 'Circular reference detected',
            dependsOn: [],
            dependents: [],
        };
        cache.set(normalized, circular);
        return circular;
    }
    const sheet = getSheetForPage(env, pageKey);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(ancestorKey);
    const rawInput = sheet.cells[normalized] ?? '';
    const trimmed = rawInput.trim();
    let result;
    if (!trimmed) {
        result = {
            address: normalized,
            raw: rawInput,
            value: '',
            display: '',
            type: 'empty',
            dependsOn: [],
            dependents: [],
        };
    }
    else if (trimmed.startsWith('=')) {
        const formula = trimmed.slice(1);
        let dependencies = [];
        try {
            const tokens = tokenize(formula);
            if (tokens.length === 0) {
                throw new Error('Empty formula');
            }
            const parser = new FormulaParser(tokens);
            const ast = parser.parse();
            dependencies = uniqueSorted(collectDependencies(ast));
            const evaluated = evaluateNode(ast, {
                getCell: (reference, ancestorsSet) => evaluateCellInternal(reference, pageKey, env, ancestorsSet),
                getExternalCell: (pageRef, reference, ancestorsSet) => evaluateExternalReferenceCell(pageRef, reference, env, ancestorsSet),
            }, nextAncestors);
            const value = flattenValue(evaluated)[0];
            const type = value === ''
                ? 'empty'
                : typeof value === 'number'
                    ? 'number'
                    : typeof value === 'boolean'
                        ? 'boolean'
                        : 'string';
            result = {
                address: normalized,
                raw: rawInput,
                value,
                display: formatDisplayValue(value),
                type,
                dependsOn: dependencies,
                dependents: [],
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Formula error';
            result = {
                address: normalized,
                raw: rawInput,
                value: '',
                display: '#ERROR',
                type: 'empty',
                error: message,
                dependsOn: dependencies,
                dependents: [],
            };
        }
    }
    else if (numberRegex.test(trimmed)) {
        const numericValue = Number(trimmed);
        result = {
            address: normalized,
            raw: rawInput,
            value: numericValue,
            display: formatDisplayValue(numericValue),
            type: 'number',
            dependsOn: [],
            dependents: [],
        };
    }
    else {
        result = {
            address: normalized,
            raw: rawInput,
            value: rawInput,
            display: rawInput,
            type: 'string',
            dependsOn: [],
            dependents: [],
        };
    }
    cache.set(normalized, result);
    return result;
}
function evaluateSheet(sheet, options = {}) {
    const rowCount = Math.max(1, sheet.rowCount);
    const columnCount = Math.max(1, sheet.columnCount);
    const pageKey = options.pageId ?? LOCAL_PAGE_KEY;
    const env = {
        options,
        caches: new Map([[pageKey, new Map()]]),
        sheets: new Map([[pageKey, sheet]]),
        pageTitles: new Map([[pageKey, options.pageTitle ?? 'Sheet']]),
        resolutionCache: new Map(),
    };
    const byAddress = {};
    const display = Array.from({ length: rowCount }, () => Array(columnCount).fill(''));
    const errors = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));
    for (let row = 0; row < rowCount; row++) {
        for (let column = 0; column < columnCount; column++) {
            const address = encodeCellAddress(row, column);
            const cell = evaluateCellInternal(address, pageKey, env, new Set());
            byAddress[address] = cell;
            display[row][column] = cell.error ? '#ERROR' : cell.display;
            errors[row][column] = cell.error ?? null;
        }
    }
    for (const cell of Object.values(byAddress)) {
        for (const dependency of cell.dependsOn) {
            const target = byAddress[dependency];
            if (!target) {
                continue;
            }
            if (!target.dependents.includes(cell.address)) {
                target.dependents = [...target.dependents, cell.address];
            }
        }
    }
    const dependencies = {};
    for (const cell of Object.values(byAddress)) {
        cell.dependsOn = uniqueSorted(cell.dependsOn);
        cell.dependents = uniqueSorted(cell.dependents);
        dependencies[cell.address] = {
            dependsOn: cell.dependsOn,
            dependents: cell.dependents,
        };
    }
    return {
        byAddress,
        display,
        errors,
        dependencies,
    };
}
function collectExternalReferencesFromNode(node, references) {
    switch (node.type) {
        case 'ExternalCellReference':
            if (!references.has(node.page.raw)) {
                references.set(node.page.raw, node.page);
            }
            break;
        case 'ExternalRange':
            if (!references.has(node.page.raw)) {
                references.set(node.page.raw, node.page);
            }
            break;
        case 'UnaryExpression':
            collectExternalReferencesFromNode(node.argument, references);
            break;
        case 'BinaryExpression':
            collectExternalReferencesFromNode(node.left, references);
            collectExternalReferencesFromNode(node.right, references);
            break;
        case 'FunctionCall':
            for (const arg of node.args) {
                collectExternalReferencesFromNode(arg, references);
            }
            break;
        default:
            break;
    }
}
function collectExternalReferences(sheet) {
    const references = new Map();
    for (const value of Object.values(sheet.cells)) {
        const rawValue = typeof value === 'string' ? value : String(value ?? '');
        const trimmed = rawValue.trim();
        if (!trimmed.startsWith('=')) {
            continue;
        }
        const formula = trimmed.slice(1);
        try {
            const tokens = tokenize(formula);
            if (tokens.length === 0) {
                continue;
            }
            const parser = new FormulaParser(tokens);
            const ast = parser.parse();
            collectExternalReferencesFromNode(ast, references);
        }
        catch {
            continue;
        }
    }
    return Array.from(references.values());
}
function sanitizeSheetData(sheet) {
    const parsed = parseSheetContent(sheet);
    const sanitizedCells = cloneCells(parsed.cells);
    for (const key of Object.keys(sanitizedCells)) {
        const normalized = key.toUpperCase();
        if (!cellRegex.test(normalized)) {
            delete sanitizedCells[key];
            continue;
        }
        try {
            const { row, column } = decodeCellAddress(normalized);
            if (row < 0 || column < 0) {
                delete sanitizedCells[key];
            }
        }
        catch {
            delete sanitizedCells[key];
        }
    }
    return {
        ...parsed,
        cells: sanitizedCells,
    };
}
function isSheetType(type) {
    return type === enums_1.PageType.SHEET;
}
