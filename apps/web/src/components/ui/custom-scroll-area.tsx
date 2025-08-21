import * as React from 'react';
import { cn } from '@/lib/utils';

type CustomScrollAreaProps = React.HTMLAttributes<HTMLDivElement>;

const CustomScrollArea = React.forwardRef<HTMLDivElement, CustomScrollAreaProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('overflow-auto middle-section-scroll', className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);

CustomScrollArea.displayName = 'CustomScrollArea';

export { CustomScrollArea };