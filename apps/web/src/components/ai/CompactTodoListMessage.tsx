import React, { useMemo, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Circle, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  position: number;
}

interface TaskList {
  id: string;
  title: string;
  description?: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface CompactTodoListMessageProps {
  tasks: Task[];
  taskList: TaskList;
  createdAt?: Date;
  onTaskUpdate?: (taskId: string, newStatus: Task['status']) => void;
}

const getStatusIcon = (status: Task['status']) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-3 h-3 text-green-500" />;
    case 'in_progress':
      return <Clock className="w-3 h-3 text-blue-500" />;
    case 'blocked':
      return <AlertCircle className="w-3 h-3 text-red-500" />;
    case 'pending':
    default:
      return <Circle className="w-3 h-3 text-gray-400" />;
  }
};

export const CompactTodoListMessage: React.FC<CompactTodoListMessageProps> = React.memo(({
  tasks,
  taskList,
  createdAt,
  onTaskUpdate
}) => {
  const [sortedTasks, setSortedTasks] = useState<Task[]>([]);

  // Sort tasks by status and position
  useEffect(() => {
    const sorted = [...tasks].sort((a, b) => {
      const statusPriority = {
        'in_progress': 0,
        'pending': 1,
        'completed': 2,
        'blocked': 3
      };
      
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      
      return a.position - b.position;
    });
    setSortedTasks(sorted);
  }, [tasks]);

  // Calculate progress
  const progress = useMemo(() => {
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
    const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return {
      total: totalTasks,
      completed: completedTasks,
      inProgress: inProgressTasks,
      percentage: progressPercentage
    };
  }, [tasks]);

  const handleTaskClick = (taskId: string, currentStatus: Task['status']) => {
    if (!onTaskUpdate) return;
    
    const statusCycle: Task['status'][] = ['pending', 'in_progress', 'completed', 'blocked'];
    const currentIndex = statusCycle.indexOf(currentStatus);
    const nextStatus = statusCycle[(currentIndex + 1) % statusCycle.length];
    
    onTaskUpdate(taskId, nextStatus);
  };

  return (
    <div className="mb-3">
      <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md p-2">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
            <h4 className="text-sm font-medium text-blue-900 dark:text-blue-100 truncate">
              {taskList.title}
            </h4>
          </div>
          <Badge variant="secondary" className="text-xs">
            {progress.percentage}%
          </Badge>
        </div>

        {/* Compact Progress Bar */}
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 mb-2">
          <div 
            className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${progress.percentage}%` }}
          />
        </div>

        {/* Task List - Show only first 3 tasks */}
        <div className="space-y-1">
          {sortedTasks.slice(0, 3).map((task) => (
            <div
              key={task.id}
              className={`flex items-center gap-2 p-1.5 rounded text-xs transition-all duration-200 ${
                task.status === 'completed' 
                  ? 'bg-green-50 dark:bg-green-950/30 opacity-75' 
                  : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700'
              } ${onTaskUpdate ? 'cursor-pointer' : ''}`}
              onClick={() => onTaskUpdate && handleTaskClick(task.id, task.status)}
            >
              <div className="flex-shrink-0">
                {getStatusIcon(task.status)}
              </div>
              
              <div className={`flex-grow truncate ${
                task.status === 'completed' 
                  ? 'line-through text-gray-500' 
                  : 'text-gray-900 dark:text-gray-100'
              }`}>
                {task.title}
              </div>

              {task.priority === 'high' && (
                <div className="w-1.5 h-1.5 rounded-full bg-red-400"></div>
              )}
            </div>
          ))}
          
          {sortedTasks.length > 3 && (
            <div className="text-xs text-gray-500 text-center py-1">
              +{sortedTasks.length - 3} more tasks
            </div>
          )}
        </div>

        {/* Footer */}
        {progress.total > 0 && (
          <div className="mt-2 pt-1.5 border-t border-blue-200 dark:border-blue-700">
            <div className="flex justify-between items-center text-xs text-blue-700 dark:text-blue-300">
              <span>
                {progress.completed}/{progress.total} complete
              </span>
              
              {createdAt && (
                <span>
                  {new Date(createdAt).toLocaleTimeString([], { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                  })}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

CompactTodoListMessage.displayName = 'CompactTodoListMessage';