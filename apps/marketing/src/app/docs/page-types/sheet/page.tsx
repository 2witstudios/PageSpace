import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Sheets",
  description: "How sheet pages work in PageSpace — cells, formulas, the supported function set, real-time sync, AI edits, and exports.",
  path: "/docs/page-types/sheet",
  keywords: ["sheets", "spreadsheet", "formulas", "cells", "csv", "xlsx", "ai"],
});

const content = `
# Sheets

A sheet is a PageSpace page type for tabular data — rows and columns of cells you can type values into, wire together with formulas, and hand to AI to read or edit. It sits in the page tree next to your [documents](/docs/page-types/document) and [channels](/docs/page-types/channel), not in a separate app.

## What you can do

- Create a sheet from the **+** button next to a folder or through the slash menu inside another page. New sheets start at 20 rows by 10 columns and grow as you type outside the grid.
- Click a cell and type to enter a value, or press **F2** or **Enter** to open the floating editor for longer input.
- Start any cell with **=** to turn it into a formula — \`=A1+B1\`, \`=SUM(A1:A10)\`, \`=IF(B2>0,"over","under")\`.
- Select a range, drag the handle, or copy and paste — with **Paste values** or **Paste formulas** if you want to control whether references shift.
- Pull a cell from another sheet into a formula by typing **@**, picking the other sheet, then typing \`:B5\` — \`=@[Budget]:B5\` or \`=SUM(@[Budget]:A1:A12)\`.
- Watch collaborators' edits land as they happen; the formula bar on top always shows the raw value behind the selected cell.
- Ask AI in a chat on the page to fill in, clean, or analyse the data — it reads the evaluated grid and can write to specific cells by address.
- Download the sheet as **.csv** or **.xlsx** from the export menu in the page header.
- Undo and redo your own edits with the usual keyboard shortcuts.

## How it works

A sheet stores values keyed by A1-style cell addresses — \`A1\`, \`B2\`, \`AA17\`. A cell is whatever you typed: a number, some text, a true/false value, or a formula string starting with \`=\`. The grid is sized by row and column counts on the sheet itself, not by the addresses you've used, and it grows when you type past the current edge.

The formula engine is PageSpace's own — not Excel, not Google Sheets, not HyperFormula. It parses each formula into an expression tree and evaluates it against the current cell values, walking dependencies as it goes. The whole sheet re-evaluates as you type.

The function set covers the common cases:

- **Math and stats:** \`SUM\`, \`AVERAGE\` (\`AVG\`), \`MIN\`, \`MAX\`, \`COUNT\`, \`COUNTA\`, \`ABS\`, \`ROUND\`, \`FLOOR\`, \`CEILING\`, \`SQRT\`, \`POWER\` (\`POW\`), \`MOD\`, \`INT\`, \`SIGN\`, \`PI\`, \`RAND\`, \`RANDBETWEEN\`.
- **Logic:** \`IF\`, \`IFERROR\`, \`AND\`, \`OR\`, \`NOT\`, \`ISBLANK\`, \`ISNUMBER\`, \`ISTEXT\`.
- **Text:** \`CONCAT\` (\`CONCATENATE\`), \`UPPER\`, \`LOWER\`, \`TRIM\`, \`LEN\`, \`LEFT\`, \`RIGHT\`, \`MID\`, \`SUBSTITUTE\`, \`REPT\`, \`FIND\`, \`SEARCH\`.
- **Dates:** \`TODAY\`, \`NOW\`, \`YEAR\`, \`MONTH\`, \`DAY\`.
- **Operators:** \`+\`, \`-\`, \`*\`, \`/\`, \`^\`, \`&\` for string concat, and \`=\`, \`<>\`, \`>\`, \`<\`, \`>=\`, \`<=\` for comparisons.
- **References:** single cells (\`A1\`), ranges (\`A1:B10\`), and cross-page references via \`@[Sheet Title]:A1\` or \`@[Sheet Title]:A1:B10\`.

A formula that loops back on itself resolves to \`#CYCLE\`; anything it can't parse or a divide-by-zero shows \`#ERROR\`.

Real-time collaboration runs through the same socket channel every other page uses. Your edits apply locally and optimistically, then a document update is sent with an incremented version number. When a teammate's edit lands, their new version of the sheet replaces yours on screen, while the cell you're actively editing stays under your cursor. Conflicts resolve at the document level, not per cell — the last version the server accepts wins the write, and everyone sees the same grid a moment later.

AI agents read and edit sheets through the same page permissions as anyone else. On an [AI Chat page](/docs/page-types/ai-chat) that can see the sheet, an agent reads the evaluated grid and writes back to specific cell addresses — values, formulas, or clears — in a single batched call. Formulas the agent writes run through the same engine as formulas you write.

## Good to know

- **Not every Excel function is here.** The supported set is listed above. Lookups (\`VLOOKUP\`, \`XLOOKUP\`, \`INDEX/MATCH\`), conditional aggregates (\`SUMIF\`, \`COUNTIF\`), and array/financial functions aren't included — formulas that reference them return \`#ERROR\`.
- **Sheets aren't unbounded.** The grid grows as you fill it, but a sheet re-evaluates from scratch on every edit. For database-sized datasets, reach for a different container.

## Related

- [Pages](/docs/features/pages) — the container every sheet lives in: version history, trash, move, share.
- [AI in your Workspace](/docs/features/ai) — how an agent on a chat page can read and edit a sheet, and how to keep it read-only.
- [Canvas](/docs/page-types/canvas) — where to put a chart or dashboard that reads from your sheet data.
- [Drives & Workspaces](/docs/features/drives) — where sheets live and who sees them by default.
- [Sharing & Permissions](/docs/features/sharing) — how per-page grants let a teammate edit one sheet without unlocking the rest of the drive.
`;

export default function HowItWorksSheetsPage() {
  return <DocsMarkdown content={content} />;
}
