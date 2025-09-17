# Drag and Drop System

## Overview

PageSpace implements a sophisticated drag-and-drop system that provides seamless interaction for both internal page reordering and external file uploads. The system is built on @dnd-kit for internal dragging and extends it with custom logic for external file handling.

## Core Components

### 1. Internal Page Reordering (Native @dnd-kit)

The internal drag-and-drop system uses @dnd-kit's sortable preset with vertical list strategy:

- **DndContext**: Main context provider in `PageTree.tsx`
- **useSortable**: Hook used by each `TreeNode` for drag behavior
- **PointerSensor**: Detects drag initiation with 8px activation distance
- **Collision Detection**: Uses `closestCenter` algorithm
- **Transform Animations**: Automatic via @dnd-kit's transform system

#### Position Detection Logic
```typescript
// Native @dnd-kit position detection
if (delta.x > 30) {
  dropPosition = 'inside';  // Dragged 30px right
} else {
  dropPosition = delta.y > 0 ? 'after' : 'before';
}
```

### 2. External File Upload (Hybrid System)

External file uploads use a hybrid approach that mimics @dnd-kit behavior:

#### Key Components

**DragState Interface**
```typescript
interface DragState {
  overId: string | null;
  dropPosition: 'before' | 'after' | 'inside' | null;
  isExternalFile?: boolean;
  displacedNodes?: Set<string>;
  mousePosition?: { x: number; y: number };
  dragStartPos?: { x: number; y: number };
}
```

**Position Detection**
- Captures drag start position on `dragEnter`
- Calculates deltaX for "inside" detection (>30px right)
- Uses element-relative positioning for before/after:
  - Top 40% = "before"
  - Bottom 40% = "after"
  - Middle 20% = maintains previous state (prevents spazzing)

**Animation System**
- 10px margin displacement for affected nodes
- 150ms cubic-bezier transition matching native timing
- Subtle 2px visual gaps instead of large separators

### 3. Upload API Integration

The `/api/upload` endpoint supports precise positioning:

```typescript
// Form data parameters
position: 'before' | 'after' | null
afterNodeId: string | null  // Target node ID

// Position calculation
if (position === 'before') {
  // Insert between previous sibling and target
  calculatedPosition = (prevPos + targetPos) / 2;
} else if (position === 'after') {
  // Insert between target and next sibling
  calculatedPosition = (targetPos + nextPos) / 2;
}
```

## Visual Feedback System

### Drop Indicators
1. **Before Drop**: Blue line above with 2px gap
2. **After Drop**: Blue line below with 2px gap  
3. **Inside Drop**: Blue ring highlight around entire node
4. **File Preview**: Floating "Upload files" indicator following cursor

### Animation Behavior
- Items smoothly displace when files hover over drop zones
- Displaced nodes move down by 10px
- Animations use same timing as native @dnd-kit (150ms)
- No jarring transitions or overlapping states

## Technical Implementation

### Event Flow

1. **Drag Enter**: 
   - Detect external files via `dataTransfer.types`
   - Capture drag start position
   - Set `isDraggingFiles` flag

2. **Drag Over**:
   - Calculate delta from start position
   - Determine drop position based on element bounds
   - Update displaced nodes set
   - Apply visual indicators

3. **Drop**:
   - Extract position and target information
   - Call `handleFileDrop` with position data
   - Upload files with positioning parameters
   - Reset drag state

### Key Algorithms

**Dead Zone Prevention**
```typescript
if (heightPercent < 0.4) {
  dropPosition = 'before';
} else if (heightPercent > 0.6) {
  dropPosition = 'after';
} else {
  // Middle 20% - maintain previous state
  dropPosition = dragState.dropPosition || 'after';
}
```

**Node Displacement Calculation**
```typescript
if (dropPosition === 'before') {
  // Displace target and all following siblings
  for (let i = targetIndex; i < siblings.length; i++) {
    displacedNodes.add(siblings[i].id);
  }
} else if (dropPosition === 'after') {
  // Displace only following siblings
  for (let i = targetIndex + 1; i < siblings.length; i++) {
    displacedNodes.add(siblings[i].id);
  }
}
```

## File Structure

- `components/layout/left-sidebar/page-tree/PageTree.tsx` - Main container with drag logic
- `components/layout/left-sidebar/page-tree/TreeNode.tsx` - Individual draggable items
- `hooks/useFileDrop.ts` - File upload handling hook
- `app/api/upload/route.ts` - Backend upload with positioning

## Performance Considerations

1. **Debouncing**: Dead zones prevent rapid state changes
2. **Set-based Operations**: Efficient displaced node tracking
3. **Conditional Rendering**: Drop indicators only render when active
4. **Margin vs Transform**: Uses margins for external drags to avoid transform conflicts

## Future Enhancements

1. Multi-file preview during drag
2. Folder expansion on hover delay
3. Drag multiple internal items simultaneously
4. Touch device support
5. Accessibility improvements for keyboard navigation