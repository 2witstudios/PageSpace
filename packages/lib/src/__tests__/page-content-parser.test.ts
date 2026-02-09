import { describe, it, expect } from 'vitest'
import { getPageContentForAI } from '../content/page-content-parser'
import { PageType } from '../utils/enums'
import type { Page } from '../types'

describe('page-content-parser', () => {
  describe('getPageContentForAI', () => {
    it('returns not found message for null page', () => {
      const result = getPageContentForAI(null as any)
      expect(result).toContain('[Page not found.]')
    })

    it('returns not found message for undefined page', () => {
      const result = getPageContentForAI(undefined as any)
      expect(result).toContain('[Page not found.]')
    })

    describe('DOCUMENT type', () => {
      it('formats document with string content', () => {
        const page = {
          id: 'doc1',
          title: 'Test Document',
          type: PageType.DOCUMENT,
          content: 'This is the document content'
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('--- Start of Context from Page: "Test Document"')
        expect(result).toContain('Type: DOCUMENT')
        expect(result).toContain('This is the document content')
        expect(result).toContain('--- End of Context from Page: "Test Document"')
      })

      it('formats document with array content (Richline format)', () => {
        const page = {
          id: 'doc1',
          title: 'Test Document',
          type: PageType.DOCUMENT,
          content: ['Line 1', 'Line 2', 'Line 3']
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('Line 1\nLine 2\nLine 3')
      })

      it('handles document with empty content', () => {
        const page = {
          id: 'doc1',
          title: 'Empty Document',
          type: PageType.DOCUMENT,
          content: null
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('No document content available.')
      })

      it('handles document with object content (fallback)', () => {
        const page = {
          id: 'doc1',
          title: 'Test Document',
          type: PageType.DOCUMENT,
          content: { type: 'custom', data: 'value' }
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('"type": "custom"')
        expect(result).toContain('"data": "value"')
      })
    })

    describe('CHANNEL type', () => {
      it('formats channel with messages', () => {
        const page = {
          id: 'ch1',
          title: 'Test Channel',
          type: PageType.CHANNEL,
          channelMessages: [
            { user: { name: 'Alice' }, content: 'Hello!' },
            { user: { name: 'Bob' }, content: 'Hi there!' }
          ]
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('Channel Messages:')
        expect(result).toContain('- Alice: Hello!')
        expect(result).toContain('- Bob: Hi there!')
      })

      it('handles channel with empty messages', () => {
        const page = {
          id: 'ch1',
          title: 'Empty Channel',
          type: PageType.CHANNEL,
          channelMessages: []
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('No channel messages available.')
      })

      it('handles channel with null messages', () => {
        const page = {
          id: 'ch1',
          title: 'Empty Channel',
          type: PageType.CHANNEL,
          channelMessages: null
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('No channel messages available.')
      })

      it('handles messages with unknown user', () => {
        const page = {
          id: 'ch1',
          title: 'Test Channel',
          type: PageType.CHANNEL,
          channelMessages: [
            { user: null, content: 'Anonymous message' }
          ]
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('- Unknown: Anonymous message')
      })
    })

    describe('FOLDER type', () => {
      it('formats folder with children', () => {
        const page = {
          id: 'f1',
          title: 'Test Folder',
          type: PageType.FOLDER,
          children: [
            { title: 'Document 1', type: PageType.DOCUMENT },
            { title: 'Subfolder', type: PageType.FOLDER },
            { title: 'Chat', type: PageType.AI_CHAT }
          ]
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('Folder Contents (Titles):')
        expect(result).toContain('- Document 1 (Type: DOCUMENT)')
        expect(result).toContain('- Subfolder (Type: FOLDER)')
        expect(result).toContain('- Chat (Type: AI_CHAT)')
      })

      it('handles empty folder', () => {
        const page = {
          id: 'f1',
          title: 'Empty Folder',
          type: PageType.FOLDER,
          children: []
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('Folder is empty.')
      })

      it('handles folder with null children', () => {
        const page = {
          id: 'f1',
          title: 'Empty Folder',
          type: PageType.FOLDER,
          children: null
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('Folder is empty.')
      })
    })

    describe('SHEET type', () => {
      it('formats sheet in SheetDoc format', () => {
        const page = {
          id: 's1',
          title: 'Test Sheet',
          type: PageType.SHEET,
          content: '#%PAGESPACE_SHEETDOC\nrows=10\ncols=10\ncells=\nA1=Hello\nB1=World'
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('Sheet in SheetDoc format:')
        expect(result).toContain('#%PAGESPACE_SHEETDOC')
        expect(result).toContain('A1=Hello')
      })

      it('formats legacy sheet format with grid display', () => {
        const page = {
          id: 's1',
          title: 'Test Sheet',
          type: PageType.SHEET,
          content: JSON.stringify({
            cells: {
              A1: 'Hello',
              B1: 'World',
              A2: '=A1&" "&B1'
            },
            rowCount: 10,
            columnCount: 10
          })
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('Sheet size: 10 rows x 10 columns')
        expect(result).toContain('Cell inputs (raw values including formulas)')
        expect(result).toContain('A1: Hello')
        expect(result).toContain('B1: World')
        expect(result).toContain('A2: =A1&" "&B1')
      })

      it('handles sheet parsing error', () => {
        const page = {
          id: 's1',
          title: 'Invalid Sheet',
          type: PageType.SHEET,
          content: 'invalid sheet data'
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('Failed to parse sheet content')
      })

      it('truncates large sheets', () => {
        const cells: Record<string, string> = {}
        for (let i = 0; i < 100; i++) {
          cells[`A${i + 1}`] = `Value ${i}`
        }

        const page = {
          id: 's1',
          title: 'Large Sheet',
          type: PageType.SHEET,
          content: JSON.stringify({
            cells,
            rowCount: 100,
            columnCount: 30
          })
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('Showing first 50 rows and 26 columns for brevity')
        expect(result).toContain('(grid truncated)')
      })

      it('handles empty sheet', () => {
        const page = {
          id: 's1',
          title: 'Empty Sheet',
          type: PageType.SHEET,
          content: JSON.stringify({
            cells: {},
            rowCount: 10,
            columnCount: 10
          })
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('All cells are currently empty')
      })
    })

    describe('unsupported types', () => {
      it('returns not implemented message for unsupported type', () => {
        const page = {
          id: 'u1',
          title: 'Unsupported Type',
          type: 'CUSTOM_TYPE' as any
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('Content extraction not implemented for page type: CUSTOM_TYPE')
      })
    })

    describe('content format handling', () => {
      it('converts array content to newline-separated text', () => {
        const page = {
          id: 'doc1',
          title: 'Test',
          type: PageType.DOCUMENT,
          content: ['First line', 'Second line', 'Third line']
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('First line\nSecond line\nThird line')
      })

      it('keeps string content as-is', () => {
        const page = {
          id: 'doc1',
          title: 'Test',
          type: PageType.DOCUMENT,
          content: 'Plain text content'
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('Plain text content')
      })

      it('JSON-stringifies unknown content formats', () => {
        const page = {
          id: 'doc1',
          title: 'Test',
          type: PageType.DOCUMENT,
          content: { custom: 'format', nested: { data: 'value' } }
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('"custom": "format"')
        expect(result).toContain('"nested"')
        expect(result).toContain('"data": "value"')
      })
    })

    describe('metadata and structure', () => {
      it('includes start and end markers', () => {
        const page = {
          id: 'doc1',
          title: 'Test Document',
          type: PageType.DOCUMENT,
          content: 'Content'
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toMatch(/^--- Start of Context from Page:/)
        expect(result).toMatch(/--- End of Context from Page:[\s\S]*$/)
      })

      it('includes page title in markers', () => {
        const page = {
          id: 'doc1',
          title: 'My Special Document',
          type: PageType.DOCUMENT,
          content: 'Content'
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('"My Special Document"')
        expect(result.match(/My Special Document/g)?.length).toBe(2) // Start and end
      })

      it('includes page type in metadata', () => {
        const page = {
          id: 'doc1',
          title: 'Test',
          type: PageType.AI_CHAT,
          content: 'Content'
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('(Type: AI_CHAT)')
      })
    })

    describe('edge cases', () => {
      it('handles page with special characters in title', () => {
        const page = {
          id: 'doc1',
          title: 'Test "Quote" & <Special> Characters',
          type: PageType.DOCUMENT,
          content: 'Content'
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('Test "Quote" & <Special> Characters')
      })

      it('handles very long content', () => {
        const longContent = 'a'.repeat(100000)
        const page = {
          id: 'doc1',
          title: 'Long Document',
          type: PageType.DOCUMENT,
          content: longContent
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain(longContent)
      })

      it('handles empty string content', () => {
        const page = {
          id: 'doc1',
          title: 'Empty',
          type: PageType.DOCUMENT,
          content: ''
        } as Page

        const result = getPageContentForAI(page)

        // Empty content should not show "No document content available"
        // since content is defined (just empty)
        expect(result).not.toContain('No document content available')
      })

      it('handles whitespace-only content', () => {
        const page = {
          id: 'doc1',
          title: 'Whitespace',
          type: PageType.DOCUMENT,
          content: '   \n\t  '
        } as Page

        const result = getPageContentForAI(page)

        expect(result).toContain('   \n\t  ')
      })
    })

    describe('all page types coverage', () => {
      it('handles AI_CHAT type', () => {
        const page = {
          id: 'chat1',
          title: 'AI Chat',
          type: PageType.AI_CHAT,
          content: null
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('Content extraction not implemented for page type: AI_CHAT')
      })

      it('handles FILE type', () => {
        const page = {
          id: 'file1',
          title: 'File',
          type: PageType.FILE,
          content: null
        } as any

        const result = getPageContentForAI(page)

        expect(result).toContain('Content extraction not implemented for page type: FILE')
      })

      it('handles CANVAS type', () => {
        const page = {
          id: 'canvas1',
          title: 'Canvas',
          type: PageType.CANVAS,
          content: '<div>HTML content</div>'
        } as Page

        const result = getPageContentForAI(page)

        // CANVAS is handled like DOCUMENT
        expect(result).toContain('<div>HTML content</div>')
      })
    })
  })
})
