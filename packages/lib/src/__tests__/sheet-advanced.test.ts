import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEmptySheet, evaluateSheet, SheetData } from '../sheet'

describe('sheet - advanced scenarios', () => {
  describe('circular reference detection', () => {
    it('detects simple circular reference', () => {
      const sheet = createEmptySheet(3, 3)
      sheet.cells.A1 = '=A2'
      sheet.cells.A2 = '=A1'

      const evaluation = evaluateSheet(sheet)

      assert.ok(evaluation.byAddress.A1.error?.includes('Circular'))
      assert.ok(evaluation.byAddress.A2.error?.includes('Circular'))
    })

    it('detects complex circular reference chain', () => {
      const sheet = createEmptySheet(5, 3)
      sheet.cells.A1 = '=A2'
      sheet.cells.A2 = '=A3'
      sheet.cells.A3 = '=A4'
      sheet.cells.A4 = '=A1'

      const evaluation = evaluateSheet(sheet)

      assert.ok(evaluation.byAddress.A1.error?.includes('Circular'))
      assert.ok(evaluation.byAddress.A4.error?.includes('Circular'))
    })

    it('allows self-referencing in different cells without circular dependency', () => {
      const sheet = createEmptySheet(5, 5)
      sheet.cells.A1 = '10'
      sheet.cells.A2 = '=A1 * 2'
      sheet.cells.A3 = '=A2 + 5'

      const evaluation = evaluateSheet(sheet)

      assert.equal(evaluation.byAddress.A1.display, '10')
      assert.equal(evaluation.byAddress.A2.display, '20')
      assert.equal(evaluation.byAddress.A3.display, '25')
    })
  })

  describe('formula edge cases', () => {
    it('handles division by zero', () => {
      const sheet = createEmptySheet(3, 3)
      sheet.cells.A1 = '10'
      sheet.cells.A2 = '0'
      sheet.cells.A3 = '=A1/A2'

      const evaluation = evaluateSheet(sheet)

      assert.ok(evaluation.byAddress.A3.display === '#ERROR' || evaluation.byAddress.A3.error)
    })

    it('handles empty cell references', () => {
      const sheet = createEmptySheet(3, 3)
      sheet.cells.A1 = '=A2 + 10'

      const evaluation = evaluateSheet(sheet)

      // Empty cell treated as 0
      assert.equal(evaluation.byAddress.A1.display, '10')
    })

    it('evaluates nested function calls', () => {
      const sheet = createEmptySheet(5, 3)
      sheet.cells.A1 = '10'
      sheet.cells.A2 = '20'
      sheet.cells.A3 = '30'
      sheet.cells.B1 = '=SUM(A1:A3)'
      sheet.cells.B2 = '=AVERAGE(A1:A3)'
      sheet.cells.C1 = '=IF(B1>50, B2, 0)'

      const evaluation = evaluateSheet(sheet)

      assert.equal(evaluation.byAddress.B1.display, '60')
      assert.equal(evaluation.byAddress.B2.display, '20')
      assert.equal(evaluation.byAddress.C1.display, '20')
    })

    it('handles text concatenation in formulas', () => {
      const sheet = createEmptySheet(3, 3)
      sheet.cells.A1 = 'Hello'
      sheet.cells.A2 = 'World'
      sheet.cells.A3 = '=CONCAT(A1, " ", A2)'

      const evaluation = evaluateSheet(sheet)

      assert.equal(evaluation.byAddress.A3.display, 'Hello World')
    })

    it('handles boolean operations', () => {
      const sheet = createEmptySheet(5, 3)
      sheet.cells.A1 = '10'
      sheet.cells.A2 = '20'
      sheet.cells.B1 = '=A1 > A2'
      sheet.cells.B2 = '=A1 < A2'
      sheet.cells.B3 = '=A1 = A1'

      const evaluation = evaluateSheet(sheet)

      assert.equal(evaluation.byAddress.B1.display, 'false')
      assert.equal(evaluation.byAddress.B2.display, 'true')
      assert.equal(evaluation.byAddress.B3.display, 'true')
    })
  })

  describe('range operations', () => {
    it('handles SUM over large ranges', () => {
      const sheet = createEmptySheet(100, 10)

      // Fill first column with numbers 1-100
      for (let i = 0; i < 100; i++) {
        sheet.cells[`A${i + 1}`] = String(i + 1)
      }

      sheet.cells.B1 = '=SUM(A1:A100)'

      const evaluation = evaluateSheet(sheet)

      // Sum of 1 to 100 = 5050
      assert.equal(evaluation.byAddress.B1.display, '5050')
    })

    it('handles AVERAGE with mixed empty cells', () => {
      const sheet = createEmptySheet(10, 3)
      sheet.cells.A1 = '10'
      sheet.cells.A2 = ''
      sheet.cells.A3 = '20'
      sheet.cells.A4 = ''
      sheet.cells.A5 = '30'
      sheet.cells.B1 = '=AVERAGE(A1:A5)'

      const evaluation = evaluateSheet(sheet)

      // Average of 10, 20, 30 = 20
      assert.equal(evaluation.byAddress.B1.display, '20')
    })

    it('handles COUNT function correctly', () => {
      const sheet = createEmptySheet(10, 3)
      sheet.cells.A1 = '10'
      sheet.cells.A2 = 'text'
      sheet.cells.A3 = '20'
      sheet.cells.A4 = ''
      sheet.cells.A5 = '30'
      sheet.cells.B1 = '=COUNT(A1:A5)'

      const evaluation = evaluateSheet(sheet)

      // Only numeric values: 10, 20, 30
      assert.equal(evaluation.byAddress.B1.display, '3')
    })
  })

  describe('performance and scalability', () => {
    it('handles large sheets efficiently', () => {
      const sheet = createEmptySheet(1000, 100)

      // Fill with simple values
      sheet.cells.A1 = '1'
      sheet.cells.B1 = '=A1 + 1'

      const evaluation = evaluateSheet(sheet)

      assert.equal(evaluation.byAddress.A1.display, '1')
      assert.equal(evaluation.byAddress.B1.display, '2')
    })

    it('handles deeply nested formula dependencies', () => {
      const sheet = createEmptySheet(20, 3)

      // Create a chain: A1 = 1, A2 = A1 + 1, A3 = A2 + 1, etc.
      sheet.cells.A1 = '1'
      for (let i = 2; i <= 20; i++) {
        sheet.cells[`A${i}`] = `=A${i-1} + 1`
      }

      const evaluation = evaluateSheet(sheet)

      assert.equal(evaluation.byAddress.A1.display, '1')
      assert.equal(evaluation.byAddress.A20.display, '20')
    })
  })

  describe('error propagation', () => {
    it('propagates errors through formulas', () => {
      const sheet = createEmptySheet(5, 3)
      sheet.cells.A1 = '=1/0' // Error
      sheet.cells.A2 = '=A1 + 10'
      sheet.cells.A3 = '=A2 * 2'

      const evaluation = evaluateSheet(sheet)

      assert.ok(evaluation.byAddress.A1.error)
      assert.ok(evaluation.byAddress.A2.error)
      assert.ok(evaluation.byAddress.A3.error)
    })

    it('does not propagate errors to unrelated cells', () => {
      const sheet = createEmptySheet(5, 3)
      sheet.cells.A1 = '=1/0' // Error
      sheet.cells.A2 = '=A1 + 10' // Error
      sheet.cells.B1 = '=5 + 5' // Should work

      const evaluation = evaluateSheet(sheet)

      assert.ok(evaluation.byAddress.A1.error)
      assert.ok(evaluation.byAddress.A2.error)
      assert.equal(evaluation.byAddress.B1.display, '10')
    })
  })
})