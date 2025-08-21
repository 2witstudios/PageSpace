import { Button } from '@/components/ui/button';
import { Grip, List } from 'lucide-react';
import { ViewMode } from './types';

interface DriveViewHeaderProps {
  viewMode: ViewMode;
  onViewChange: (mode: ViewMode) => void;
}

export function DriveViewHeader({ viewMode, onViewChange }: DriveViewHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div>{/* Placeholder for future breadcrumbs or title */}</div>
      <div className="flex items-center gap-2">
        <Button
          variant={viewMode === 'list' ? 'secondary' : 'ghost'}
          size="icon"
          onClick={() => onViewChange('list')}
        >
          <List className="h-4 w-4" />
        </Button>
        <Button
          variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
          size="icon"
          onClick={() => onViewChange('grid')}
        >
          <Grip className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}