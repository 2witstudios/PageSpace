"use client"

import React from 'react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { 
  CheckCircle, 
  Clock, 
  Loader2, 
  XCircle, 
  ChevronDown,
  File
} from 'lucide-react'

// Task status type
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'error'

// Main Task container
interface TaskProps extends React.ComponentProps<typeof Collapsible> {
  defaultOpen?: boolean
}

export function Task({ defaultOpen = false, className, ...props }: TaskProps) {
  return (
    <Collapsible 
      defaultOpen={defaultOpen}
      className={cn("border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900", className)}
      {...props}
    />
  )
}

// Task trigger/header
interface TaskTriggerProps extends React.ComponentProps<typeof CollapsibleTrigger> {
  title: string
  status?: TaskStatus
  progress?: { completed: number; total: number }
  icon?: React.ReactNode
}

export function TaskTrigger({ 
  title, 
  status = 'pending', 
  progress, 
  icon,
  className, 
  ...props 
}: TaskTriggerProps) {
  const getStatusIcon = () => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-600" />
      case 'in_progress':
        return <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
      case 'error':
        return <XCircle className="h-4 w-4 text-red-600" />
      default:
        return <Clock className="h-4 w-4 text-gray-400" />
    }
  }

  const getStatusColor = () => {
    switch (status) {
      case 'completed':
        return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
      case 'in_progress':
        return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
      case 'error':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
      default:
        return 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
    }
  }

  return (
    <CollapsibleTrigger 
      className={cn(
        "w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors",
        getStatusColor(),
        className
      )}
      {...props}
    >
      <div className="flex items-center space-x-3 flex-1 min-w-0">
        {icon && <div className="flex-shrink-0">{icon}</div>}
        {getStatusIcon()}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
            {title}
          </div>
          {progress && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {progress.completed} of {progress.total} operations
            </div>
          )}
        </div>
      </div>
      <ChevronDown className="h-4 w-4 text-gray-500 transition-transform duration-200 [&[data-state=open]]:rotate-180" />
    </CollapsibleTrigger>
  )
}

// Task content container
export function TaskContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent 
      className={cn("border-t border-gray-200 dark:border-gray-700", className)}
      {...props}
    >
      <div className="p-3 space-y-2">
        {children}
      </div>
    </CollapsibleContent>
  )
}

// Individual task item
interface TaskItemProps extends React.ComponentProps<"div"> {
  status?: TaskStatus
  icon?: React.ReactNode
}

export function TaskItem({ 
  status = 'completed', 
  icon,
  className, 
  children, 
  ...props 
}: TaskItemProps) {
  const getStatusIcon = () => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-3 w-3 text-green-600" />
      case 'in_progress':
        return <Loader2 className="h-3 w-3 text-blue-600 animate-spin" />
      case 'error':
        return <XCircle className="h-3 w-3 text-red-600" />
      default:
        return <Clock className="h-3 w-3 text-gray-400" />
    }
  }

  return (
    <div 
      className={cn(
        "flex items-center space-x-2 text-sm py-1",
        className
      )}
      {...props}
    >
      {getStatusIcon()}
      {icon && <div className="flex-shrink-0">{icon}</div>}
      <div className="flex-1 text-gray-700 dark:text-gray-300">
        {children}
      </div>
    </div>
  )
}

// File reference component
export function TaskItemFile({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span 
      className={cn(
        "inline-flex items-center space-x-1 px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono",
        className
      )}
      {...props}
    >
      <File className="h-3 w-3" />
      <span>{children}</span>
    </span>
  )
}