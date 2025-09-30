# PageSpace Spreadsheet Implementation Plan

## Executive Summary

Based on comprehensive agent consultation (codebase-researcher, linus-advisor, ai-sdk-expert), we'll implement spreadsheet support using proven, production-ready architecture that integrates seamlessly with PageSpace's existing patterns while ensuring AI can interact effectively with spreadsheet data.

## Architecture Decisions

### **Core Technology Stack**
- **Grid Component**: AG Grid Community (proven performance, virtualization)
- **Formula Engine**: HyperFormula (battle-tested Excel compatibility)
- **Storage**: Sparse cell table + block storage for large sheets
- **Real-time**: Yjs CRDT for conflict-free collaboration
- **AI Integration**: Hybrid format (CSV for reading, structured operations for editing)

### **Data Architecture**
```sql
-- New tables for spreadsheet support
CREATE TABLE spreadsheet_data (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  sheet_name TEXT NOT NULL,
  sheet_data JSONB NOT NULL, -- HyperFormula format
  metadata JSONB,
  UNIQUE(page_id, sheet_name)
);

-- Sparse cell storage for large sheets
CREATE TABLE cells (
  sheet_id UUID NOT NULL,
  row_idx INTEGER NOT NULL,
  col_idx INTEGER NOT NULL,
  value_text TEXT,
  value_num NUMERIC,
  formula TEXT,
  cell_type TEXT DEFAULT 'text',
  PRIMARY KEY (sheet_id, row_idx, col_idx)
);
```

### **AI Integration Strategy**
- **Reading Format**: CSV with metadata for AI comprehension
- **Writing Format**: Structured operations validated through Zod schemas
- **Tools**: 6 core tools (read_spreadsheet, set_cells, insert_rows, analyze_data, create_formula, batch_operations)
- **Streaming**: Real-time operation progress via Vercel AI SDK
- **Security**: All inputs validated, formulas sanitized

## Agent Consultation Results

### **Codebase Researcher Findings**
- **Existing Patterns**: PageSpace uses flexible page type system with centralized configuration
- **Database Schema**: Current `pages` table supports new page types via enum extension
- **Component Architecture**: Three-view system (Monaco/TipTap/Prettier) can be replicated for spreadsheets
- **Real-time Infrastructure**: Socket.IO system ready for cell-level updates
- **Dependencies**: Need to add spreadsheet libraries (currently none installed)
- **Integration Points**: File upload/conversion system, permissions, AI tools, search/indexing all need updates

### **Linus Technical Review**
**Critical Issues Identified:**
- ❌ **JSON in text field**: Performance disaster for large sheets, hot-row contention
- ❌ **HTML tables**: Browser performance cliff, DOM manipulation nightmare
- ❌ **Custom formula engine**: Years of complexity, circular references, function compatibility
- ❌ **Naive real-time**: Race conditions, last-write-wins data corruption

**Recommended Solutions:**
- ✅ **Sparse cell table**: Only store non-empty cells, block storage for large sheets
- ✅ **AG Grid**: Battle-tested virtualization, handles millions of cells
- ✅ **HyperFormula**: Production-proven Excel compatibility
- ✅ **Yjs CRDT**: Proper conflict-free collaboration

**Performance Targets:**
- Load time: <2s for 100k cells
- Cell edit latency: <50ms
- Concurrent users: 10+ without conflicts
- Memory usage: <500MB for largest sheets

### **AI SDK Expert Guidance**
**AI Interaction Strategy:**
- **Reading**: CSV format with metadata (AI-friendly)
- **Writing**: Structured operations via Zod-validated tools
- **Streaming**: Progressive operation updates via AI SDK
- **Tools Design**: 6 semantic tools matching spreadsheet workflows

**Vercel AI SDK Integration:**
```typescript
const spreadsheetTools = {
  read_spreadsheet: tool({ /* CSV format output */ }),
  set_cells: tool({ /* Structured operations */ }),
  insert_rows: tool({ /* Structural changes */ }),
  analyze_data: tool({ /* Statistical analysis */ }),
  create_formula: tool({ /* Natural language formulas */ }),
  batch_operations: tool({ /* Performance optimization */ })
};
```

## Implementation Phases

### **Phase 1: Core Infrastructure (Week 1-2)**
1. Add SPREADSHEET to PageType enum in `packages/lib/src/enums.ts`
2. Create database schema and migrations in `packages/db/src/schema/`
3. Install dependencies: `ag-grid-community`, `hyperformula`, `yjs`
4. Create SpreadsheetView component with AG Grid integration
5. Basic CRUD operations for spreadsheet data
6. Update page type configuration in `packages/lib/src/page-types.config.ts`

### **Phase 2: Formula Engine & Real-time (Week 3-4)**
1. Integrate HyperFormula for Excel-compatible calculations
2. Implement Yjs for real-time collaboration
3. Socket.IO integration for broadcasting changes via existing `broadcastPageEvent()`
4. Cell-level update optimization
5. Import/export functionality (Excel, CSV) via existing file system
6. Extend existing API routes in `apps/web/src/app/api/pages/`

### **Phase 3: AI Integration (Week 5-6)**
1. Create 6 AI tools with Zod validation in `apps/web/src/lib/ai/tools/`
2. Implement CSV-with-metadata reading format
3. Structured operation execution engine
4. Streaming tool results integration via Vercel AI SDK
5. AI formula generation from natural language
6. Extend existing AI chat system to understand spreadsheet context

### **Phase 4: UI Polish & Performance (Week 7-8)**
1. Three-view architecture (Grid, Formula bar, Data view) following DocumentView patterns
2. Performance optimization for large sheets (virtualization, lazy loading)
3. UI/UX improvements using existing shadcn/ui components
4. Error handling and validation
5. Integration with existing mentions system, search, and permissions
6. Documentation and testing

## Key Technical Components

### **SpreadsheetView Component**
```typescript
const SpreadsheetView = ({ pageId, content, onChange, readOnly }) => {
  // AG Grid for grid rendering with virtualization
  // HyperFormula for Excel-compatible calculations
  // Yjs for real-time collaboration
  // Socket.IO for broadcasting via existing patterns
  // Integration with existing DocumentView architecture
};
```

### **Database Integration**
```typescript
// Extend existing PageType enum
export enum PageType {
  DOCUMENT = 'DOCUMENT',
  FILE = 'FILE',
  FOLDER = 'FOLDER',
  SPREADSHEET = 'SPREADSHEET', // New addition
}

// Page type configuration
[PageType.SPREADSHEET]: {
  type: PageType.SPREADSHEET,
  displayName: 'Spreadsheet',
  description: 'Collaborative spreadsheet with formulas',
  iconName: 'Table',
  emoji: '📊',
  capabilities: {
    canHaveChildren: false,
    supportsRealtime: true,
    supportsVersioning: true,
    canBeConverted: true
  },
  uiComponent: 'SpreadsheetView',
  layoutViewType: 'document'
}
```

### **AI Tools Structure**
```typescript
// AI Reading Format
{
  format: 'csv_with_metadata',
  data: 'Month,Revenue,Costs\nJan,10000,7000\nFeb,12000,8000',
  metadata: {
    sheets: ['Sheet1'],
    dimensions: { rows: 3, cols: 3 },
    namedRanges: { 'Revenue': 'B:B', 'Costs': 'C:C' }
  },
  formulas: { 'D2': '=B2-C2' }
}

// AI Writing Format
{
  operations: [
    { type: 'setCells', range: 'A1:C1', values: ['Month', 'Revenue', 'Costs'] },
    { type: 'setFormula', range: 'D2', formula: '=B2-C2' }
  ]
}
```

## PageSpace Integration Points

### **Existing Systems to Extend**
1. **Page Type System**: Add SPREADSHEET to enum, update configurations
2. **Component Architecture**: Create SpreadsheetView following DocumentView patterns
3. **Database Schema**: Extend pages table, add spreadsheet-specific tables
4. **Real-time System**: Use existing Socket.IO infrastructure with cell-level events
5. **File System**: Extend upload/conversion system for Excel/CSV import
6. **AI Tools**: Add spreadsheet tools to existing AI assistant framework
7. **Permissions**: Reuse existing RBAC system (view/edit/delete)
8. **Search/Indexing**: Update to index spreadsheet cell content
9. **Mentions System**: Enable @mentions within spreadsheet cells

### **API Routes to Create/Extend**
- `GET /api/pages/[pageId]` - Add spreadsheet data handling
- `POST /api/pages/[pageId]/convert` - Excel/CSV conversion
- `GET /api/pages/[pageId]/export` - Download as Excel/CSV
- `POST /api/files/[id]/convert-to-spreadsheet` - File conversion
- Socket.IO events for real-time collaboration

### **Dependencies to Install**
```json
{
  "dependencies": {
    "ag-grid-community": "^31.0.0",
    "hyperformula": "^2.6.0",
    "yjs": "^13.6.0",
    "y-websocket": "^1.5.0",
    "exceljs": "^4.4.0",
    "papaparse": "^5.4.0"
  },
  "devDependencies": {
    "@types/papaparse": "^5.3.0"
  }
}
```

## Risk Mitigation

### **Technical Risks**
- **Large sheet performance**: Block storage + AG Grid virtualization
- **Formula complexity**: Use proven HyperFormula library
- **Real-time conflicts**: Yjs CRDT prevents data corruption
- **AI tool reliability**: Comprehensive Zod validation
- **Integration complexity**: Follow existing PageSpace patterns exactly

### **Implementation Risks**
- **Scope creep**: Focus on core features first, match existing page types
- **Performance degradation**: Implement with proven virtualization
- **Security vulnerabilities**: Sanitize all formulas, reuse existing auth
- **User experience**: Follow existing three-view architecture

## Success Metrics

### **Functionality**
- [ ] Basic spreadsheet operations (CRUD, formulas, formatting)
- [ ] Excel/CSV import and export
- [ ] Real-time collaboration without conflicts
- [ ] AI natural language to spreadsheet operations
- [ ] Integration with existing PageSpace features (mentions, search, permissions)

### **Performance**
- [ ] Load time: <2s for 100k cells
- [ ] Cell edit latency: <50ms
- [ ] Memory usage: <500MB for largest sheets
- [ ] Concurrent users: 10+ simultaneous editors

### **Integration**
- [ ] Seamless user experience consistent with documents
- [ ] AI assistant understands and manipulates spreadsheet data
- [ ] File upload/conversion works with existing system
- [ ] Real-time updates work with existing Socket.IO infrastructure

## Dependencies and Installation

### **Required Packages**
```bash
# Core spreadsheet functionality
pnpm add ag-grid-community hyperformula

# Real-time collaboration
pnpm add yjs y-websocket

# Import/export support
pnpm add exceljs papaparse

# Type definitions
pnpm add -D @types/papaparse
```

### **Database Migrations**
```sql
-- Add SPREADSHEET to pageType enum
ALTER TYPE "pageType" ADD VALUE 'SPREADSHEET';

-- Create spreadsheet data table
CREATE TABLE spreadsheet_data (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  sheet_name TEXT NOT NULL DEFAULT 'Sheet1',
  sheet_data JSONB NOT NULL DEFAULT '{"cells": {}, "metadata": {}}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(page_id, sheet_name)
);

-- Indexes for performance
CREATE INDEX spreadsheet_data_page_id_idx ON spreadsheet_data(page_id);
CREATE INDEX spreadsheet_data_updated_at_idx ON spreadsheet_data(updated_at);
```

## Next Steps

1. **Approval**: Confirm architectural approach and timeline
2. **Environment Setup**: Install required packages and run migrations
3. **Phase 1 Development**: Begin core infrastructure implementation
4. **Continuous Integration**: Test each phase before proceeding
5. **User Testing**: Validate UX consistency with existing PageSpace patterns

## Conclusion

This implementation plan leverages proven technologies (AG Grid, HyperFormula, Yjs) while integrating seamlessly with PageSpace's existing architecture. The phased approach ensures we can deliver working functionality quickly while building toward a production-ready system that handles large spreadsheets and real-time collaboration effectively.

The AI integration strategy provides natural language spreadsheet manipulation while maintaining security and performance, making PageSpace's spreadsheet feature a powerful addition to the existing document and file management capabilities.