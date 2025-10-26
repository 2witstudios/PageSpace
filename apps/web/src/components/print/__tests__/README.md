# Print Component Tests

## Current Test Coverage

### Unit Tests (39 tests, 100% passing)

**ReadOnlyEditor.test.tsx** - 19 tests
- ✅ Component mounting and rendering
- ✅ Editor configuration (editable: false, extensions)
- ✅ Content handling and updates
- ✅ DOM mounting callbacks
- ✅ Edge cases (long content, special characters)

**PrintView.test.tsx** - 20 tests
- ✅ Component mounting and props validation
- ✅ Loading state UI
- ✅ Security (DOMPurify integration)
- ✅ Component structure basics
- ✅ Edge cases and accessibility

---

## Integration/E2E Tests (Planned for Phase 12-14)

The following features require **Playwright** or browser-based integration tests because they involve:
- Browser APIs (window.print, document.fonts)
- Complex async state transitions
- Next.js build-time features (styled-jsx)
- Actual DOM rendering with CSS

### Required Integration Tests:

#### 1. **Print Dialog Triggering**
- `window.print()` is called after pagination completes
- Print dialog appears in browser
- Print can be cancelled without errors
- Cleanup happens after print dialog closes

**Why not unit tested:** Requires browser environment, can't mock window.print reliably

---

#### 2. **Pagination Calculation Flow**
- Editor mounts → onMount callback fires
- `isEditorMounted` state updates
- Pagination calculation runs
- Page breaks calculated correctly
- Content split into pages
- Loading state → Ready state transition

**Why not unit tested:** Complex async flow with React state updates, timing-dependent, needs full React lifecycle

---

#### 3. **Font Loading**
- `document.fonts.ready` promise resolves
- Pagination waits for fonts before calculating
- Heights measured after fonts load
- No layout shift during font loading

**Why not unit tested:** Requires browser font loading API, can't reliably mock

---

#### 4. **Print CSS Rendering**
- `@media print` rules applied correctly
- Page breaks work (`page-break-after: always`)
- Hidden editor is actually hidden
- Page dimensions are correct (8.5in × 11in)
- Print preview matches expected layout

**Why not unit tested:** styled-jsx requires Next.js build environment, can't test CSS rendering in jsdom

---

#### 5. **Content Splitting Accuracy**
- Content elements split at correct break points
- No content lost during splitting
- Page containers have correct elements
- `dangerouslySetInnerHTML` renders correctly
- DOMPurify sanitizes malicious content

**Why not unit tested:** Requires full Tiptap rendering with actual DOM measurements

---

#### 6. **Visual Regression**
- Print output matches editor pagination view
- Typography is identical (fonts, spacing, sizing)
- Page breaks appear at same positions
- No layout drift between editor and print

**Why not unit tested:** Requires visual comparison, screenshot diffing

---

## Test Strategy

### Unit Tests (Current)
**Scope:** Synchronous, deterministic behavior
- Props validation
- Error handling
- Component structure
- Security integration

**Tools:** Vitest + React Testing Library

---

### Integration Tests (Phase 12-14)
**Scope:** Full feature flows end-to-end
- Print dialog triggering
- Pagination calculation
- Font loading
- CSS rendering
- Content splitting

**Tools:** Playwright

---

### Visual Regression Tests (Phase 12)
**Scope:** Layout and typography fidelity
- Editor vs print comparison
- Page break alignment
- Font rendering

**Tools:** Playwright + Percy/Chromatic

---

## Running Tests

```bash
# Unit tests (current)
pnpm exec vitest run src/components/print/__tests__/

# Integration tests (future - Phase 12)
pnpm test:e2e -- print

# Visual regression (future - Phase 12)
pnpm test:visual
```

---

## Notes

- **Unit tests focus on behavior, not implementation**
- **Avoid testing Next.js build-time features (styled-jsx) in unit tests**
- **Complex async flows should be integration tested**
- **Visual fidelity requires screenshot comparison**
