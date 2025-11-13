# Sheet Template Example

## Default TOML Template for New Sheets

When a new SHEET page is created, it now includes a default template with example data to help AI models understand the SheetDoc format. Here's what the template contains:

### Template Content

The template creates a simple product pricing table with:
- **Column Headers**: Item, Quantity, Price, Total
- **Sample Data Rows**: Two products with quantities and prices
- **Formulas**: Multiplication formulas to calculate totals (=B2*C2, =B3*C3)
- **Aggregate Formula**: A SUM formula to total all products (=SUM(D2:D3))

### Example Output (SheetDoc TOML Format)

```toml
#%PAGESPACE_SHEETDOC v1

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 20
column_count = 10

[sheets.cells.A1]
value = "Item"
type = "string"

[sheets.cells.A2]
value = "Product A"
type = "string"

[sheets.cells.A3]
value = "Product B"
type = "string"

[sheets.cells.A5]
value = "Total"
type = "string"

[sheets.cells.B1]
value = "Quantity"
type = "string"

[sheets.cells.B2]
value = 10
type = "number"

[sheets.cells.B3]
value = 5
type = "number"

[sheets.cells.C1]
value = "Price"
type = "string"

[sheets.cells.C2]
value = 25.5
type = "number"

[sheets.cells.C3]
value = 42
type = "number"

[sheets.cells.D1]
value = "Total"
type = "string"

[sheets.cells.D2]
formula = "=B2*C2"
value = 255
type = "number"

[sheets.cells.D3]
formula = "=B3*C3"
value = 210
type = "number"

[sheets.cells.D5]
formula = "=SUM(D2:D3)"
value = 465
type = "number"

[sheets.dependencies.D2]
depends_on = ["B2", "C2"]
dependents = ["D5"]

[sheets.dependencies.D3]
depends_on = ["B3", "C3"]
dependents = ["D5"]

[sheets.dependencies.D5]
depends_on = ["D2", "D3"]
dependents = []
```

## Benefits for AI

This template helps AI models understand:

1. **Cell Structure**: How cells are defined with addresses (A1, B2, etc.)
2. **Data Types**: Different types of values (string, number)
3. **Formulas**: How formulas are written with `=` prefix and cell references
4. **Computed Values**: Each formula cell shows both the formula and computed value
5. **Dependencies**: The dependency graph shows which cells depend on others
6. **TOML Syntax**: Proper formatting for sections, keys, and values

## Implementation

The template is generated in `/home/user/PageSpace/packages/lib/src/page-types.config.ts` by the `createTemplateSheet()` function, which:

1. Creates a sheet with default dimensions (20 rows x 10 columns)
2. Populates example cells with headers and data
3. Adds formulas that reference other cells
4. Serializes to SheetDoc TOML format with computed values and dependencies

This ensures every new sheet provides a clear example of the expected format, making it easier for AI to write correct sheet updates.
