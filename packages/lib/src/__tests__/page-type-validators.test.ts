import { describe, it, expect } from 'vitest'
import {
  validatePageCreation,
  validatePageUpdate,
  canConvertToType,
  getValidationRules,
  validateAIChatTools
} from '../content/page-type-validators'
import { PageType } from '../utils/enums'

describe('page-type-validators', () => {
  describe('validatePageCreation', () => {
    it('validates valid DOCUMENT creation', () => {
      const result = validatePageCreation(PageType.DOCUMENT, {
        title: 'Test Document'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates valid FOLDER creation', () => {
      const result = validatePageCreation(PageType.FOLDER, {
        title: 'Test Folder'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates valid AI_CHAT creation with all fields', () => {
      const result = validatePageCreation(PageType.AI_CHAT, {
        title: 'Test Chat',
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-sonnet',
        systemPrompt: 'You are a helpful assistant',
        enabledTools: ['search', 'calculator']
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects AI_CHAT with invalid systemPrompt type', () => {
      const result = validatePageCreation(PageType.AI_CHAT, {
        title: 'Test Chat',
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-sonnet',
        systemPrompt: 123
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('systemPrompt must be a string')
    })

    it('rejects AI_CHAT with invalid enabledTools type', () => {
      const result = validatePageCreation(PageType.AI_CHAT, {
        title: 'Test Chat',
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-sonnet',
        enabledTools: 'not-an-array'
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('enabledTools must be an array')
    })

    it('rejects AI_CHAT with invalid aiProvider type', () => {
      const result = validatePageCreation(PageType.AI_CHAT, {
        title: 'Test Chat',
        aiProvider: 123,
        aiModel: 'anthropic/claude-3-sonnet'
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('aiProvider must be a string')
    })

    it('rejects AI_CHAT with invalid aiModel type', () => {
      const result = validatePageCreation(PageType.AI_CHAT, {
        title: 'Test Chat',
        aiProvider: 'openrouter',
        aiModel: ['not', 'a', 'string']
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('aiModel must be a string')
    })

    it('validates valid FILE creation with mimeType', () => {
      const result = validatePageCreation(PageType.FILE, {
        title: 'Test File',
        mimeType: 'application/pdf'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates valid FILE creation with filePath', () => {
      const result = validatePageCreation(PageType.FILE, {
        title: 'Test File',
        filePath: '/path/to/file.pdf'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects FILE creation without mimeType or filePath', () => {
      const result = validatePageCreation(PageType.FILE, {
        title: 'Test File'
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('FILE type requires either mimeType or filePath')
    })

    it('validates valid SHEET creation', () => {
      const result = validatePageCreation(PageType.SHEET, {
        title: 'Test Sheet',
        content: '#%PAGESPACE_SHEETDOC\nrows=10\ncols=10\ncells=\n'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects SHEET with invalid content', () => {
      const result = validatePageCreation(PageType.SHEET, {
        title: 'Test Sheet',
        content: 'invalid sheet format'
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Invalid sheet content')
    })

    it('validates CHANNEL creation', () => {
      const result = validatePageCreation(PageType.CHANNEL, {
        title: 'Test Channel'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates CANVAS creation', () => {
      const result = validatePageCreation(PageType.CANVAS, {
        title: 'Test Canvas'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })
  })

  describe('validatePageUpdate', () => {
    it('validates valid title update', () => {
      const result = validatePageUpdate(PageType.DOCUMENT, {
        title: 'Updated Title'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects non-string title', () => {
      const result = validatePageUpdate(PageType.DOCUMENT, {
        title: 123
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Title must be a string')
    })

    it('validates string content for DOCUMENT', () => {
      const result = validatePageUpdate(PageType.DOCUMENT, {
        content: 'Updated content'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects non-string content for DOCUMENT', () => {
      const result = validatePageUpdate(PageType.DOCUMENT, {
        content: { invalid: 'object' }
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Content must be a string for document/canvas pages')
    })

    it('validates string content for CANVAS', () => {
      const result = validatePageUpdate(PageType.CANVAS, {
        content: '<div>HTML content</div>'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates valid JSON string content for CHANNEL', () => {
      const result = validatePageUpdate(PageType.CHANNEL, {
        content: JSON.stringify({ messages: [] })
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects invalid JSON for CHANNEL', () => {
      const result = validatePageUpdate(PageType.CHANNEL, {
        content: 'not valid json'
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Content must be valid JSON for channel/chat pages')
    })

    it('validates valid JSON string content for AI_CHAT', () => {
      const result = validatePageUpdate(PageType.AI_CHAT, {
        content: JSON.stringify({ messages: [] })
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates valid sheet content for SHEET', () => {
      const result = validatePageUpdate(PageType.SHEET, {
        content: '#%PAGESPACE_SHEETDOC\nrows=10\ncols=10\ncells=\n'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects invalid sheet content for SHEET', () => {
      const result = validatePageUpdate(PageType.SHEET, {
        content: 'invalid'
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Content must be valid sheet data')
    })

    it('rejects non-string content for SHEET', () => {
      const result = validatePageUpdate(PageType.SHEET, {
        content: 123
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Content must be a string for sheet pages')
    })

    it('validates AI_CHAT systemPrompt update', () => {
      const result = validatePageUpdate(PageType.AI_CHAT, {
        systemPrompt: 'New prompt'
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates AI_CHAT systemPrompt set to null', () => {
      const result = validatePageUpdate(PageType.AI_CHAT, {
        systemPrompt: null
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects AI_CHAT systemPrompt with invalid type', () => {
      const result = validatePageUpdate(PageType.AI_CHAT, {
        systemPrompt: 123
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('systemPrompt must be a string or null')
    })

    it('validates AI_CHAT enabledTools update', () => {
      const result = validatePageUpdate(PageType.AI_CHAT, {
        enabledTools: ['tool1', 'tool2']
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates AI_CHAT enabledTools set to null', () => {
      const result = validatePageUpdate(PageType.AI_CHAT, {
        enabledTools: null
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects AI_CHAT enabledTools with invalid type', () => {
      const result = validatePageUpdate(PageType.AI_CHAT, {
        enabledTools: 'not-an-array'
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('enabledTools must be an array or null')
    })

    it('allows updates with no changes', () => {
      const result = validatePageUpdate(PageType.DOCUMENT, {})
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })
  })

  describe('canConvertToType', () => {
    it('allows FILE to DOCUMENT conversion', () => {
      const canConvert = canConvertToType(PageType.FILE, PageType.DOCUMENT)
      expect(canConvert).toBe(true)
    })

    it('disallows DOCUMENT to FILE conversion', () => {
      const canConvert = canConvertToType(PageType.DOCUMENT, PageType.FILE)
      expect(canConvert).toBe(false)
    })

    it('disallows FOLDER to DOCUMENT conversion', () => {
      const canConvert = canConvertToType(PageType.FOLDER, PageType.DOCUMENT)
      expect(canConvert).toBe(false)
    })

    it('disallows AI_CHAT to DOCUMENT conversion', () => {
      const canConvert = canConvertToType(PageType.AI_CHAT, PageType.DOCUMENT)
      expect(canConvert).toBe(false)
    })

    it('disallows same-type conversion', () => {
      const canConvert = canConvertToType(PageType.DOCUMENT, PageType.DOCUMENT)
      expect(canConvert).toBe(false)
    })
  })

  describe('getValidationRules', () => {
    it('returns validation rules for DOCUMENT', () => {
      const rules = getValidationRules(PageType.DOCUMENT)

      expect(rules).toHaveProperty('requiredFields')
      expect(rules).toHaveProperty('optionalFields')
      expect(rules).toHaveProperty('capabilities')
      expect(Array.isArray(rules.requiredFields)).toBe(true)
      expect(Array.isArray(rules.optionalFields)).toBe(true)
    })

    it('returns validation rules for AI_CHAT', () => {
      const rules = getValidationRules(PageType.AI_CHAT)

      expect(rules).toHaveProperty('requiredFields')
      expect(rules).toHaveProperty('capabilities')
    })

    it('returns capabilities for FOLDER', () => {
      const rules = getValidationRules(PageType.FOLDER)

      expect(rules.capabilities).toHaveProperty('canAcceptUploads')
      expect(rules.capabilities.canAcceptUploads).toBe(true)
    })

    it('returns capabilities for FILE', () => {
      const rules = getValidationRules(PageType.FILE)

      expect(rules.capabilities).toHaveProperty('canBeConverted')
      expect(rules.capabilities.canBeConverted).toBe(true)
    })
  })

  describe('validateAIChatTools', () => {
    const availableTools = ['read_page', 'write_page', 'search', 'calculator']

    it('validates valid tools', () => {
      const result = validateAIChatTools(['read_page', 'search'], availableTools)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects invalid tools', () => {
      const result = validateAIChatTools(['invalid_tool'], availableTools)

      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('Invalid tools specified')
      expect(result.errors[0]).toContain('invalid_tool')
    })

    it('rejects mix of valid and invalid tools', () => {
      const result = validateAIChatTools(['read_page', 'fake_tool', 'search'], availableTools)

      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('fake_tool')
    })

    it('validates empty tools array', () => {
      const result = validateAIChatTools([], availableTools)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates null tools', () => {
      const result = validateAIChatTools(null, availableTools)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('validates undefined tools', () => {
      const result = validateAIChatTools(undefined, availableTools)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('provides helpful error message with available tools', () => {
      const result = validateAIChatTools(['wrong_tool'], availableTools)

      expect(result.errors[0]).toContain('Available tools:')
      expect(result.errors[0]).toContain('read_page')
      expect(result.errors[0]).toContain('search')
    })

    it('validates all available tools', () => {
      const result = validateAIChatTools(availableTools, availableTools)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })
  })

  describe('edge cases', () => {
    it('handles missing data object gracefully', () => {
      const result = validatePageCreation(PageType.DOCUMENT, undefined as any)

      // Should handle gracefully, not throw
      expect(result).toHaveProperty('valid')
      expect(result).toHaveProperty('errors')
    })

    it('handles empty data object', () => {
      const result = validatePageCreation(PageType.DOCUMENT, {})

      expect(result).toHaveProperty('valid')
      expect(result).toHaveProperty('errors')
    })

    it('handles update with undefined fields', () => {
      const result = validatePageUpdate(PageType.DOCUMENT, {
        title: undefined,
        content: undefined
      })

      expect(result).toHaveProperty('valid')
    })
  })
})
