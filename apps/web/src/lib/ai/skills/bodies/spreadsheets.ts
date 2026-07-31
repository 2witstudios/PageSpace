/**
 * spreadsheets skill body — code-shipped instructions for creating and
 * editing SHEET pages. Loaded on demand via load_skill / the /spreadsheets
 * chip; keep in sync with packages/lib/src/sheets.
 */
export const SPREADSHEETS_SKILL_BODY = `# Spreadsheets (SHEET pages)

A SHEET page is PageSpace's interactive spreadsheet: a single grid of cells with a formula engine. New sheets start at 20 rows x 10 columns and grow automatically when you write outside the current bounds. Like any page, a sheet can be nested anywhere and can contain child pages.

## Editing: always use edit_sheet_cells

Sheets store structured cell data, not editable text. \`replace_lines\` (and other line/text editing tools) **refuse SHEET pages** with "Cannot use line editing on sheets" — the stored text is a generated serialization that includes computed values and dependency tables, so editing it as text would corrupt or discard state. \`edit_sheet_cells\` is the only write path.

Tool contract:

- \`pageId\` (optional) — the sheet page to edit; defaults to the page currently in view.
- \`cells\` — an array of \`{ address, value }\` updates. Batch as many cells as you can into one call instead of calling once per cell.
- \`address\` — A1-style, e.g. \`"A1"\`, \`"B2"\`, \`"AA100"\`. Case-insensitive; normalized to uppercase.
- \`value\` — always a string:
  - Starts with \`=\` → stored as a formula.
  - Empty string \`""\` → clears the cell.
  - Looks like a number (\`"42"\`, \`"-3.14"\`, \`".5"\`) → treated as a number.
  - Anything else → plain text.

Writing to an address beyond the current grid (e.g. \`Z50\` on a 20x10 sheet) expands the sheet to include it. The result reports how many values, formulas, and clears were applied; verify with \`read_page\` afterwards.

To create a new spreadsheet: \`create_page\` with \`type: "SHEET"\` (it initializes an empty 20x10 grid), then populate it with one batched \`edit_sheet_cells\` call.

## Addressing

- Cells: one or more letters + row number — \`A1\`, \`B12\`, \`AA100\`. Columns run A..Z, AA..AZ, etc.; rows are 1-indexed.
- Ranges: \`A1:B10\` (rectangular, inclusive, either corner order). Ranges **must be bounded** — whole-column (\`A:A\`) and whole-row (\`1:1\`) references do not exist and will fail to parse.
- Absolute references \`$A$1\`, \`A$1\`, \`$A1\` are accepted in formulas. They evaluate identically to \`A1\`; the \`$\` only pins the row/column when a user copies cells in the UI.

## Formulas

A formula is any cell value starting with \`=\`, e.g. \`=SUM(B2:B10)\`, \`=A1*1.2\`, \`=IF(C2>100, "over", "under")\`.

### Operators

\`+\` \`-\` \`*\` \`/\` \`^\` (power), \`&\` (string concatenation), and comparisons \`=\` \`<>\` \`>\` \`<\` \`>=\` \`<=\` (returning TRUE/FALSE).

- \`+\` tries numeric addition; if either side is non-numeric it silently falls back to string concatenation. Use \`&\` when you mean concatenation.
- \`/\` by zero is an error.
- \`=\` and \`<>\` compare numerically when both sides coerce to numbers, otherwise by string.
- Empty cells coerce to 0 in numeric contexts; numeric-looking strings coerce to numbers; other text in a numeric operation causes an error.
- String literals use double quotes only (\`"text"\`). There is no escape for a double quote inside a formula string.
- Boolean literals \`TRUE\` / \`FALSE\` work inside formulas. A raw cell containing \`true\` is just text (though \`IF\` still treats the strings "TRUE"/"FALSE" as booleans).

### Supported functions — the complete list

These 43 functions (46 names counting the aliases AVG, CONCATENATE, and POW) are **everything** the engine supports. Any other name — including common Excel functions — fails with "Unsupported function NAME" and the cell shows \`#ERROR\`.

**Math and aggregation**

| Function | Signature | Notes |
|---|---|---|
| SUM | \`SUM(v1, ...)\` | Coerces every value; non-numeric text anywhere in the range errors the formula |
| AVERAGE / AVG | \`AVERAGE(v1, ...)\` | Skips blanks and non-numeric values; 0 when nothing numeric |
| MIN | \`MIN(v1, ...)\` | Coerces all values; 0 on empty input |
| MAX | \`MAX(v1, ...)\` | Coerces all values; 0 on empty input |
| COUNT | \`COUNT(v1, ...)\` | Counts numbers, booleans, and numeric strings |
| COUNTA | \`COUNTA(v1, ...)\` | Counts all non-empty values |
| ABS | \`ABS(n)\` | |
| ROUND | \`ROUND(n, [digits])\` | digits defaults to 0 |
| FLOOR | \`FLOOR(n, [significance])\` | significance defaults to 1; must not be 0 |
| CEILING | \`CEILING(n, [significance])\` | significance defaults to 1; must not be 0 |
| INT | \`INT(n)\` | Floor to integer |
| SQRT | \`SQRT(n)\` | Errors on negative input |
| POWER / POW | \`POWER(base, exp)\` | Same as the \`^\` operator |
| MOD | \`MOD(n, divisor)\` | Errors when divisor is 0 |
| SIGN | \`SIGN(n)\` | Returns -1, 0, or 1 |
| PI | \`PI()\` | |
| RAND | \`RAND()\` | Random in [0, 1) |
| RANDBETWEEN | \`RANDBETWEEN(low, high)\` | Random integer, inclusive |

**Logical and type tests**

| Function | Signature | Notes |
|---|---|---|
| IF | \`IF(cond, then, [else])\` | else defaults to empty string. **All three arguments evaluate eagerly — IF does NOT short-circuit**, so \`=IF(B2=0, "", A2/B2)\` still errors when B2 is 0. Use IFERROR to guard, not IF |
| IFERROR | \`IFERROR(expr, fallback)\` | The only lazy function and the only working error guard |
| AND | \`AND(v1, ...)\` | |
| OR | \`OR(v1, ...)\` | |
| NOT | \`NOT(v)\` | |
| ISBLANK | \`ISBLANK(v)\` | |
| ISNUMBER | \`ISNUMBER(v)\` | True only for actual numbers, not numeric text |
| ISTEXT | \`ISTEXT(v)\` | |

**Text**

| Function | Signature | Notes |
|---|---|---|
| CONCAT / CONCATENATE | \`CONCAT(v1, ...)\` | Same as chained \`&\` |
| UPPER | \`UPPER(text)\` | |
| LOWER | \`LOWER(text)\` | |
| TRIM | \`TRIM(text)\` | |
| LEN | \`LEN(text)\` | |
| LEFT | \`LEFT(text, [n])\` | n defaults to 1 |
| RIGHT | \`RIGHT(text, [n])\` | n defaults to 1 |
| MID | \`MID(text, start, count)\` | start is 1-indexed |
| SUBSTITUTE | \`SUBSTITUTE(text, old, new, [instance])\` | Replaces all occurrences unless instance given |
| REPT | \`REPT(text, times)\` | times over 10000 is an error (not clamped) |
| FIND | \`FIND(needle, haystack, [start])\` | Case-sensitive; returns 1-indexed position; **errors** when not found (wrap in IFERROR) |
| SEARCH | \`SEARCH(needle, haystack, [start])\` | Like FIND but case-insensitive |

**Date**

| Function | Signature | Notes |
|---|---|---|
| TODAY | \`TODAY()\` | Returns the string "YYYY-MM-DD" |
| NOW | \`NOW()\` | Returns an ISO-8601 timestamp string |
| YEAR | \`YEAR(dateText)\` | Parses a date string; errors on invalid dates |
| MONTH | \`MONTH(dateText)\` | 1-12 |
| DAY | \`DAY(dateText)\` | |

Dates are plain strings — there are no date serial numbers and no date arithmetic (no DATE, DATEDIF, EDATE, or subtracting dates). Caveat: YEAR/MONTH/DAY parse a bare "YYYY-MM-DD" as UTC midnight but extract with local time, so in negative-UTC-offset environments the result can be off by one day/month near boundaries — don't rely on them for exact date boundaries.

### Error values

Every failed cell **displays** \`#ERROR\` — there are no Excel-style \`#DIV/0!\`, \`#N/A\`, \`#REF!\`, or \`#VALUE!\` displays, and circular references also render as \`#ERROR\` in the grid. The distinction lives in the stored data: read the page and each errored cell carries \`error = { type = "EVAL_ERROR" | "CIRCULAR_REF", message = "..." }\` with the exact failure message (for a cycle, the details list the cell and its direct precedents). Causes include: unsupported function, non-numeric operand, division by zero, FIND miss, invalid date, unavailable cross-page reference, circular reference.

An errored cell's value is empty, so any formula referencing it errors too — errors propagate through dependents. Fix the offending cell with \`edit_sheet_cells\` (usually: replace an unsupported function, quote text properly, or break the cycle). \`IFERROR(expr, fallback)\` is the only in-formula way to absorb an expected error (remember IF does not short-circuit). One edge: a non-finite result (e.g. \`=2^2000\`) displays \`#ERROR\` but stores no \`error\` object and serializes its value as 0.

## Cross-sheet references

Reference cells in *another SHEET page* with an \`@[...]\` mention inside a formula:

- Single cell: \`=@[Budget 2026]:B2\`
- Range: \`=SUM(@[Budget 2026]:B2:B20)\`
- Disambiguated by page ID: \`=@[Budget 2026](pageid123):B2\` — the parenthesized identifier is the target page's ID and wins over the label.

Resolution: the identifier is tried first (must be a SHEET page); otherwise the label is matched case-insensitively against sheet page titles in the drive tree. Duplicate titles are ranked (siblings of the current sheet first, then most shared ancestry, then shallowest, then position) — so **include the page ID whenever you know it**. The label must be non-empty and the target must be a SHEET page.

Important: cross-page references only resolve in the live sheet view. The evaluation that runs when \`edit_sheet_cells\` saves has no page resolver, so immediately after writing a cross-sheet formula, \`read_page\` will show the cell with \`error = { message = "Cross-page references are not supported in this context" }\`. The formula itself is stored correctly and evaluates for users viewing the sheet — do not "fix" this error by removing the reference.

## Reading a sheet

\`read_page\` on a SHEET returns its stored serialization with line numbers: a \`#%PAGESPACE_SHEETDOC v1\` header followed by TOML. Example:

\`\`\`
#%PAGESPACE_SHEETDOC v1
page_id = "abc123"

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 20
column_count = 10

[sheets.cells.A1]
value = "Item"
type = "string"

[sheets.cells.B2]
value = 1200
type = "number"

[sheets.cells.B4]
formula = "=SUM(B2:B3)"
value = 2200
type = "number"

[sheets.dependencies.B4]
depends_on = ["B2", "B3"]
dependents = []
\`\`\`

How to read it:

- Only non-empty cells appear, sorted by address (note: lexicographic, so A10 sorts before A2).
- Formula cells show both the \`formula\` and its computed \`value\` — you never need to re-derive results.
- Errored cells carry an \`error\` inline table with type and message.
- \`[sheets.dependencies.*]\` maps each cell's precedents/dependents — useful for tracing what breaks if you change a cell.
- Everything except the raw inputs (formula text and literal values) is **derived and regenerated on every save**. Never try to write \`value\`, \`type\`, \`error\`, or \`dependencies\` yourself; \`edit_sheet_cells\` recomputes them.

## Structuring a new sheet

- Row 1: header labels (plain text). Data starts at row 2.
- One record per row, one field per column; keep a column consistently numeric or consistently text.
- Put totals/aggregates in a clearly labeled row below the data (e.g. \`A11\` = "Total", \`B11\` = \`=SUM(B2:B10)\`) or a summary block to the right — and leave a blank row so the data range can grow.
- Since blank cells coerce to 0, make aggregate ranges slightly generous (\`=SUM(B2:B20)\` over 10 data rows is safe for SUM/AVERAGE).
- Store numbers as bare numbers (\`1200\`, not \`"$1,200"\` — currency symbols and thousands separators make the value text and break math). Put units in the header.
- Store dates as \`YYYY-MM-DD\` strings so YEAR/MONTH/DAY can parse them.
- Send the whole initial population — headers, data, formulas — as one \`edit_sheet_cells\` batch.

## Common pitfalls

1. **Guessing Excel functions.** VLOOKUP, XLOOKUP, INDEX, MATCH, SUMIF, SUMIFS, COUNTIF, AVERAGEIF, TEXT, DATE, DATEDIF, EOMONTH, TEXTJOIN, SPLIT, PROPER, MEDIAN, STDEV, PRODUCT, ROUNDUP, ROUNDDOWN, TRUNC, EXP, LN, LOG, ARRAYFORMULA — none exist. Only the table above is real. For conditional aggregation, add a helper column of \`IF(...)\` values and SUM it.
2. **Unbounded ranges.** \`=SUM(A:A)\` is a parse error. Always use bounded ranges like \`A2:A50\`.
3. **Newlines in cell values.** Never put a line break inside a cell value — the stored TOML cannot represent it, and a sheet whose serialization fails to parse comes back **empty** (silent data loss). Keep every cell single-line.
4. **Leading \`=\` on literal text.** Any value starting with \`=\` becomes a formula; there is no apostrophe-escape. Don't start plain-text values with \`=\`.
5. **Text in numeric ranges.** One non-numeric string inside \`SUM\`'s range errors the whole formula (AVERAGE skips it instead). Keep data columns clean; don't mix "N/A" into number columns — leave the cell empty.
6. **FIND/SEARCH on a miss is an error**, not -1 or blank. Wrap in \`IFERROR\` if absence is expected.
7. **Formatted numbers.** \`"$1,200"\` or \`"85%"\` are text. Enter \`1200\` and \`0.85\`.
8. **Cross-sheet error right after writing** ("Cross-page references are not supported in this context") is expected on save — see Cross-sheet references above.
9. **Editing the sheet as text.** Never write SheetDoc TOML via any text tool, even if you've read it — hand-built TOML that parses incorrectly resets the sheet to empty. All writes go through \`edit_sheet_cells\`.
`;
