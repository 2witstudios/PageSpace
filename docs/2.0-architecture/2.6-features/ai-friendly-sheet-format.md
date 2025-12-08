# AI-Friendly Sheet Format & Engine Plan

## Summary
This document proposes a production-ready sheet representation and calculation pipeline that keeps the spreadsheet UX intact while giving PageSpace's AI agents line-precise, syntax-resilient control that mirrors the HTML-based document workflow. The plan introduces a textual `SheetDoc` format, a dependency-aware calculation engine that avoids HyperFormula, and a set of AI tools modeled after the existing `replace_lines` pattern.

## Goals Recap
1. **Intuitive to the AI** – agents should learn the format with minimal priming (analogous to HTML for rich text pages).
2. **Surface both formulas and values** so AI can understand intent and outcomes.
3. **Syntax-resilient edits** that can be diffed, code-reviewed, and merged safely.
4. **Incremental cell/range updates** that parallel `replace_lines`.
5. **Dependency visibility** for upstream/downstream impact analysis.
6. **Meaningful diffs** for collaboration/versioning.
7. **No HyperFormula**, while keeping Excel/Google Sheets parity for end users.
8. **Preserve Excel/Google Sheets-like UI** in the product.

## SheetDoc: Canonical Text Format
We store every spreadsheet page as a UTF-8 text file with the extension `.sheetdoc`. The structure is deterministic, whitespace-normalized, and easy to diff.

```
#%PAGESPACE_SHEETDOC v1
page_id = "page_123"

[[sheets]]
name = "Budget 2025"
order = 0

[sheets.meta]
row_count = 200
column_count = 12
frozen_rows = 1
frozen_columns = 1

[sheets.columns]
A = { header = "Category", width = 220 }
B = { header = "Jan", width = 120, format = "currency" }
C = { header = "Feb", width = 120, format = "currency" }

[sheets.cells.A1]
value = "Category"
type = "string"

[sheets.cells.B2]
formula = "=SUM(D2:D6)"
value = 12500
type = "currency"
notes = ["Auto-summed from expense rows"]

[sheets.cells.C2]
value = 13250
type = "currency"

[sheets.ranges.OperatingExpenses]
ref = "D2:D12"
style = { bold = true, background = "#F9F9F9" }

[sheets.dependencies.B2]
depends_on = ["D2", "D3", "D4", "D5", "D6"]
dependents = ["E2"]
```

### Why This Works
- **Line-oriented:** Each cell lives in its own section (`[sheets.cells.A1]`), so edits map to single-block diffs and `replace_lines` updates.
- **Toml semantics:** Toml is familiar to LLMs, enforces key/value syntax, and has mature parsers. We can reuse `@iarna/toml` in Node.
- **Deterministic ordering:** Sort sheets, then columns, then cells (A1..Z999) so git diffs remain stable.
- **Formula + value in one place:** Agents see both the expression and the computed number/string immediately.
- **Optional fields:** Styling, validation, notes, column metadata, filters, pivot settings, etc., can be serialized in nested tables without breaking readability.

## Storage & Runtime Flow
1. **Canonical storage:** `SheetDoc` lives in the same blob store the document HTML currently uses (Postgres `TEXT` column or S3 file). No JSON payloads.
2. **Runtime materialization:** On load, we parse `.sheetdoc` into an in-memory model consumed by the React grid (AG Grid / Handsontable / similar). Formatting and behaviors remain unchanged for users.
3. **Persistence:** When the user edits through the UI, we update the structured model then re-emit a normalized `SheetDoc` string before persisting to keep parity with AI edits.
4. **Search/indexing:** Since the canonical representation is text, existing indexing pipelines can reuse the same content (cells become tokens).

## AI Interaction Model
We extend the document editing toolkit with sheet-specific commands.

### Tools
- `read_sheet_doc(page_id, sheet?: string)` → returns the `SheetDoc` text (optionally scoped to one sheet to reduce tokens).
- `replace_sheetdoc_lines(page_id, start, end, new_text)` → identical contract to `replace_lines`, targeting the `.sheetdoc` file.
- `set_cells(page_id, operations[])` → struct-like updates (`{ sheet: "Budget 2025", range: "B2:D5", formula?: string, value?: number | string, format?: string }`). Internally converts to precise line replacements to keep git/blame meaningful.
- `get_dependencies(page_id, refs[])` → surfaces upstream/downstream dependency sets already stored in the document (and recomputed after edits).

### Agent UX
- Primary representation: `SheetDoc` snippet.
- Secondary helpers: value-only CSV or pivot summaries for natural language reasoning (`read_sheet_summary` tool) without altering canonical editing flow.

## Dependency Graph & Calculation Engine
### Engine Requirements
- Excel-compatible formulas (core arithmetic, lookups, aggregates, logicals).
- Dependency graph for re-computation and AI visibility.
- No restrictive licenses.

### Proposed Stack
- **Parser:** [`excel-formula-parser`](https://www.npmjs.com/package/excel-formula-parser) (MIT) for turning formulas into ASTs.
- **Evaluator:** [`formulajs`](https://www.npmjs.com/package/formulajs) (MIT) exposes a rich set of Excel-equivalent functions.
- **Graph runtime:** A new internal package `@pagespace/sheet-engine` that:
  - Parses formulas into ASTs.
  - Extracts cell/range references to build a directed acyclic graph (DAG).
  - Evaluates cells topologically using `formulajs` for function execution and native math for simple operations.
  - Detects and reports circular dependencies with helpful errors stored in the `SheetDoc` (e.g., `error = { type = "CIRCULAR_REF", details = ["B2", "C2"] }`).
  - Emits dependency metadata for each cell so AI can request `depends_on`/`dependents` lists without recomputation.

This engine runs both server-side (authoritative computation) and optionally in the client for optimistic updates. The formulas stay 100% in TypeScript—no HyperFormula.

### Update Cycle
1. User or AI changes cells.
2. Engine recalculates affected nodes (delta recalculation by traversing dependency graph from the changed cells outwards).
3. Update `value`, `error`, and dependency sections inside the `SheetDoc` before persisting.
4. Broadcast diffs to collaborators via existing realtime infrastructure.

## Incremental Persistence Strategy
- **Internal model:** Represent sheets as `Map<CellRef, CellRecord>` plus metadata.
- **Diff emission:** When cells change, compute the minimal set of `SheetDoc` blocks to rewrite (same approach as HTML where we only replace touched lines).
- **Server enforcement:** API endpoints accept either `SheetDoc` text (for AI) or structured operations (for UI). They convert everything back to `SheetDoc` before storing.
- **Versioning:** Git/history diffs show cell-by-cell edits, e.g., `formula = "=SUM(D2:D6)"` → `formula = "=SUM(D2:D7)"`.

## Preserving the User Interface
- Continue to use an Excel-style grid (existing AG Grid experiment or Handsontable).
- Parsing/rendering pipeline translates `SheetDoc` to the grid state.
- User actions generate operations that mutate the in-memory model and produce normalized `SheetDoc` output. Styling, comments, filters, etc., stay fully supported.
- Export/import: we maintain CSV/XLSX conversion utilities that translate between workbook formats and `SheetDoc`.

## Implementation Roadmap
1. **Create `@pagespace/sheet-engine` package**
   - AST parsing, dependency graph builder, evaluator, serializer to/from `SheetDoc`.
   - Unit tests for formula coverage, circular detection, dependency emission.
2. **Add `.sheetdoc` serializer**
   - Deterministic ordering, pretty printing, whitespace normalization, merge-safe.
3. **API & persistence changes**
   - Store sheet pages as text.
   - Provide endpoints for `read_sheet_doc`, `apply_sheet_operations`, `get_dependencies`.
4. **UI integration**
   - Convert `SheetDoc` to grid state and back.
   - Show dependency insights (hover to view upstream/downstream cells).
5. **AI tooling**
   - Implement the new tools and add guardrails (range validation, diff previews, error surfaces).
6. **Migration**
   - Convert existing JSON sheets into `SheetDoc` using a one-off migration script.
   - Re-run engine to backfill dependency sections.
7. **Testing**
   - Snapshot tests for `.sheetdoc` output.
   - Graph/evaluation tests for representative sheets.
   - E2E verifying AI can adjust budgets, add rows, and keep formulas intact.

## Benefits
- **AI-ready:** Familiar, low-noise syntax that invites precise edits without extra primers.
- **Human-friendly:** Engineers and PMs can read diffs directly in GitHub.
- **License-safe:** Relies on MIT-licensed parser/evaluator components.
- **Extensible:** Additional metadata (conditional formatting, data validation) fits naturally into the format.
- **Deterministic collaboration:** Both AI and humans operate on the same canonical text representation, ensuring conflict-free merges.

## Open Questions & Next Steps
- Decide on the exact subset of Excel formulas we must support in v1; prioritize SUM/AVG/LOOKUP/IF/DATE.
- Performance profiling of the custom engine on 10k+ cell workbooks (optimize with memoization or Web Workers if needed).
- Determine whether to expose condensed `SheetDoc` views (e.g., `cells` only) for extremely large sheets to manage token usage.

With `SheetDoc` and the accompanying engine/tooling, PageSpace attains the same AI collaboration ergonomics that made HTML-backed documents successful—without sacrificing the spreadsheet experience end users expect.
