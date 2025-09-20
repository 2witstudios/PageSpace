export interface DependencyInfo {
  dependents: Set<string>;
  precedents: Set<string>;
}

export class DependencyTracker {
  private dependents: Map<string, Set<string>> = new Map();
  private precedents: Map<string, Set<string>> = new Map();

  addDependency(dependent: string, precedent: string): void {
    // Add dependent -> precedent relationship
    if (!this.precedents.has(dependent)) {
      this.precedents.set(dependent, new Set());
    }
    this.precedents.get(dependent)!.add(precedent);

    // Add precedent -> dependent relationship
    if (!this.dependents.has(precedent)) {
      this.dependents.set(precedent, new Set());
    }
    this.dependents.get(precedent)!.add(dependent);
  }

  removeDependency(dependent: string, precedent: string): void {
    // Remove dependent -> precedent relationship
    const precedentsSet = this.precedents.get(dependent);
    if (precedentsSet) {
      precedentsSet.delete(precedent);
      if (precedentsSet.size === 0) {
        this.precedents.delete(dependent);
      }
    }

    // Remove precedent -> dependent relationship
    const dependentsSet = this.dependents.get(precedent);
    if (dependentsSet) {
      dependentsSet.delete(dependent);
      if (dependentsSet.size === 0) {
        this.dependents.delete(precedent);
      }
    }
  }

  removeAllDependencies(cellRef: string): void {
    // Remove all precedents for this cell
    const precedentsSet = this.precedents.get(cellRef);
    if (precedentsSet) {
      precedentsSet.forEach(precedent => {
        this.removeDependency(cellRef, precedent);
      });
    }

    // Remove this cell as a dependent from all its precedents
    const dependentsSet = this.dependents.get(cellRef);
    if (dependentsSet) {
      dependentsSet.forEach(dependent => {
        this.removeDependency(dependent, cellRef);
      });
    }
  }

  removePrecedents(cellRef: string): void {
    // Only remove what this cell depends on, but keep it as a precedent for others
    const precedentsSet = this.precedents.get(cellRef);
    if (precedentsSet) {
      precedentsSet.forEach(precedent => {
        this.removeDependency(cellRef, precedent);
      });
    }
  }

  getDependents(cellRef: string): string[] {
    const dependentsSet = this.dependents.get(cellRef);
    return dependentsSet ? Array.from(dependentsSet) : [];
  }

  getPrecedents(cellRef: string): string[] {
    const precedentsSet = this.precedents.get(cellRef);
    return precedentsSet ? Array.from(precedentsSet) : [];
  }

  getAllDependents(cellRef: string): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const traverse = (cell: string) => {
      const directDependents = this.getDependents(cell);

      directDependents.forEach(dependent => {
        if (!visited.has(dependent)) {
          visited.add(dependent);
          result.push(dependent);
          traverse(dependent);
        }
      });
    };

    traverse(cellRef);
    return result;
  }

  getCalculationOrder(changedCells: string[]): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    const visit = (cellRef: string): boolean => {
      if (visiting.has(cellRef)) {
        // Circular reference detected
        throw new Error(`Circular reference detected involving cell ${cellRef}`);
      }

      if (visited.has(cellRef)) {
        return true;
      }

      visiting.add(cellRef);

      // Visit all precedents first
      const precedents = this.getPrecedents(cellRef);
      for (const precedent of precedents) {
        if (!visit(precedent)) {
          return false;
        }
      }

      visiting.delete(cellRef);
      visited.add(cellRef);
      result.push(cellRef);

      return true;
    };

    // Collect all cells that need to be recalculated
    const cellsToRecalculate = new Set<string>();

    changedCells.forEach(cellRef => {
      cellsToRecalculate.add(cellRef);
      this.getAllDependents(cellRef).forEach(dependent => {
        cellsToRecalculate.add(dependent);
      });
    });

    // Sort them topologically
    Array.from(cellsToRecalculate).forEach(cellRef => {
      if (!visited.has(cellRef)) {
        visit(cellRef);
      }
    });

    return result;
  }

  detectCircularReference(cellRef: string): boolean {
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const hasCircularRef = (cell: string): boolean => {
      if (visiting.has(cell)) {
        return true;
      }

      if (visited.has(cell)) {
        return false;
      }

      visiting.add(cell);

      const precedents = this.getPrecedents(cell);
      for (const precedent of precedents) {
        if (hasCircularRef(precedent)) {
          return true;
        }
      }

      visiting.delete(cell);
      visited.add(cell);
      return false;
    };

    return hasCircularRef(cellRef);
  }

  updateDependencies(cellRef: string, newPrecedents: string[]): void {
    // Remove all existing dependencies for this cell
    this.removeAllDependencies(cellRef);

    // Add new dependencies
    newPrecedents.forEach(precedent => {
      this.addDependency(cellRef, precedent);
    });
  }

  hasDependencies(cellRef: string): boolean {
    return this.precedents.has(cellRef) && this.precedents.get(cellRef)!.size > 0;
  }

  hasDependents(cellRef: string): boolean {
    return this.dependents.has(cellRef) && this.dependents.get(cellRef)!.size > 0;
  }

  clear(): void {
    this.dependents.clear();
    this.precedents.clear();
  }

  getDependencyInfo(): { [cellRef: string]: DependencyInfo } {
    const info: { [cellRef: string]: DependencyInfo } = {};

    const allCells = new Set([
      ...this.dependents.keys(),
      ...this.precedents.keys()
    ]);

    allCells.forEach(cellRef => {
      info[cellRef] = {
        dependents: this.dependents.get(cellRef) || new Set(),
        precedents: this.precedents.get(cellRef) || new Set()
      };
    });

    return info;
  }
}