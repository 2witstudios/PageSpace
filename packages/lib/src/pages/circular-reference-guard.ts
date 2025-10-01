import { db, pages, eq } from '@pagespace/db';

/**
 * Check if setting newParentId as parent of pageId would create a circular reference
 * Returns true if it WOULD create a circle (invalid operation)
 */
export async function wouldCreateCircularReference(
  pageId: string,
  newParentId: string | null
): Promise<boolean> {
  // Null parent is always safe (moving to root)
  if (!newParentId) return false;

  // Self-reference is circular
  if (pageId === newParentId) return true;

  // Check if newParentId is a descendant of pageId
  return await isDescendant(newParentId, pageId);
}

/**
 * Check if potentialDescendantId is a descendant of ancestorId
 * Uses iterative traversal with cycle detection
 */
export async function isDescendant(
  potentialDescendantId: string,
  ancestorId: string
): Promise<boolean> {
  const visited = new Set<string>();
  let currentId: string | null = potentialDescendantId;
  const MAX_DEPTH = 100; // Safety limit
  let depth = 0;

  while (currentId) {
    // Depth limit check
    depth++;
    if (depth > MAX_DEPTH) {
      throw new Error(
        `Page tree depth exceeded ${MAX_DEPTH}. Potential circular reference detected.`
      );
    }

    // Cycle detection
    if (visited.has(currentId)) {
      throw new Error(
        `Circular reference detected in existing page tree at page: ${currentId}`
      );
    }
    visited.add(currentId);

    // Found the ancestor
    if (currentId === ancestorId) {
      return true;
    }

    // Traverse up the tree
    const page: { parentId: string | null } | undefined = await db.query.pages.findFirst({
      where: eq(pages.id, currentId),
      columns: { parentId: true },
    });

    currentId = page?.parentId || null;
  }

  return false;
}

/**
 * Validate that a page move operation is safe
 * Throws descriptive errors if validation fails
 */
export async function validatePageMove(
  pageId: string,
  newParentId: string | null
): Promise<{ valid: true } | { valid: false; error: string }> {
  try {
    const wouldCreateCircle = await wouldCreateCircularReference(pageId, newParentId);

    if (wouldCreateCircle) {
      return {
        valid: false,
        error: 'Cannot set parent: would create circular reference in page tree'
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Page move validation failed'
    };
  }
}
