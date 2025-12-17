import React, { useMemo, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { getTaskStatusIcon } from './task-utils';
import type { Task } from './useAggregatedTasks';

interface TaskList {
  id: string;
  title: string;
  description?: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface TodoListMessageProps {
  tasks: Task[];
  taskList: TaskList;
  createdAt?: Date;
  onTaskUpdate?: (taskId: string, newStatus: Task['status']) => void;
}

// Custom colors for TodoListMessage
const TODO_LIST_COLORS = {
  completed: 'text-green-600',
  in_progress: 'text-primary',
  blocked: 'text-red-600',
  pending: 'text-gray-400',
};

const getPriorityColor = (priority: Task['priority']) => {
  switch (priority) {
    case 'high':
      return 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300';
    case 'medium':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300';
    case 'low':
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
  }
};

const getStatusColor = (status: Task['status']) => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300';
    case 'in_progress':
      return 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary';
    case 'blocked':
      return 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300';
    case 'pending':
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
  }
};

export const TodoListMessage: React.FC<TodoListMessageProps> = React.memo(({
  tasks,
  taskList,
  createdAt,
  onTaskUpdate
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const [sortedTasks, setSortedTasks] = useState<Task[]>([]);

  // Sort tasks by position and status
  useEffect(() => {
    const sorted = [...tasks].sort((a, b) => {
      // First by status priority (in_progress, pending, completed, blocked)
      const statusPriority = {
        'in_progress': 0,
        'pending': 1,
        'completed': 2,
        'blocked': 3
      };
      
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      
      // Then by position
      return a.position - b.position;
    });
    setSortedTasks(sorted);
  }, [tasks]);

  // Calculate progress
  const progress = useMemo(() => {
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
    const pendingTasks = tasks.filter(t => t.status === 'pending').length;
    const blockedTasks = tasks.filter(t => t.status === 'blocked').length;
    const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return {
      total: totalTasks,
      completed: completedTasks,
      inProgress: inProgressTasks,
      pending: pendingTasks,
      blocked: blockedTasks,
      percentage: progressPercentage
    };
  }, [tasks]);

  const handleTaskClick = (taskId: string, currentStatus: Task['status']) => {
    if (!onTaskUpdate) return;
    
    // Cycle through statuses on click
    const statusCycle: Task['status'][] = ['pending', 'in_progress', 'completed', 'blocked'];
    const currentIndex = statusCycle.indexOf(currentStatus);
    const nextStatus = statusCycle[(currentIndex + 1) % statusCycle.length];
    
    onTaskUpdate(taskId, nextStatus);
  };

  return (
    <div className="mb-4 mr-8">
      <Card className="bg-primary/10 dark:bg-primary/20 border-primary/20 dark:border-primary/30">
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-primary/15 dark:hover:bg-primary/25 transition-colors">
              <CardTitle className="flex items-center justify-between text-lg">
                <div className="flex items-center gap-3">
                  {isOpen ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-primary"></div>
                    {taskList.title}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {progress.completed}/{progress.total} tasks
                  </Badge>
                  <div className="text-sm text-gray-500">
                    {progress.percentage}%
                  </div>
                </div>
              </CardTitle>

              {/* Progress bar */}
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mt-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress.percentage}%` }}
                />
              </div>
              
              {taskList.description && (
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                  {taskList.description}
                </p>
              )}
            </CardHeader>
          </CollapsibleTrigger>
          
          <CollapsibleContent>
            <CardContent className="pt-0">
              <div className="space-y-2">
                {sortedTasks.map((task) => (
                  <div
                    key={task.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border transition-all duration-200 ${
                      task.status === 'completed' 
                        ? 'bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 opacity-75' 
                        : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:shadow-sm'
                    } ${onTaskUpdate ? 'cursor-pointer' : ''}`}
                    onClick={() => onTaskUpdate && handleTaskClick(task.id, task.status)}
                  >
                    <div className="flex-shrink-0">
                      {getTaskStatusIcon(task.status, 'w-4 h-4', TODO_LIST_COLORS)}
                    </div>
                    
                    <div className="flex-grow min-w-0">
                      <div className={`font-medium ${task.status === 'completed' ? 'line-through text-gray-500' : 'text-gray-900 dark:text-gray-100'}`}>
                        {task.title}
                      </div>
                      
                      {task.description && (
                        <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                          {task.description}
                        </div>
                      )}
                      
                      {task.metadata?.notes && task.metadata.notes.length > 0 && (
                        <div className="text-xs text-gray-500 mt-1">
                          Latest: {task.metadata.notes[task.metadata.notes.length - 1].content}
                        </div>
                      )}
                    </div>
                    
                    <div className="flex-shrink-0 flex items-center gap-2">
                      {task.priority !== 'medium' && (
                        <Badge variant="outline" className={`text-xs ${getPriorityColor(task.priority)}`}>
                          {task.priority}
                        </Badge>
                      )}
                      
                      <Badge variant="outline" className={`text-xs ${getStatusColor(task.status)}`}>
                        {task.status.replace('_', ' ')}
                      </Badge>
                      
                      {task.metadata?.estimatedMinutes && (
                        <div className="text-xs text-gray-500">
                          ~{task.metadata.estimatedMinutes}min
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              
              {progress.total > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <div className="flex justify-between text-xs text-gray-500">
                    <div className="flex gap-4">
                      {progress.pending > 0 && (
                        <span>📋 {progress.pending} pending</span>
                      )}
                      {progress.inProgress > 0 && (
                        <span>⏳ {progress.inProgress} in progress</span>
                      )}
                      {progress.blocked > 0 && (
                        <span>🚫 {progress.blocked} blocked</span>
                      )}
                    </div>
                    
                    {createdAt && (
                      <span>
                        Created {new Date(createdAt).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    </div>
  );
});

TodoListMessage.displayName = 'TodoListMessage';