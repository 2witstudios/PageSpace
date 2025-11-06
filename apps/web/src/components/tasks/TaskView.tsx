'use client';

import { useState, useEffect } from 'react';
import { PageType } from '@pagespace/lib/enums';

interface TaskMetadata {
  id: string;
  pageId: string;
  assigneeId: string | null;
  assignerId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueDate: string | null;
  startDate: string | null;
  completedAt: string | null;
  estimatedHours: number | null;
  actualHours: number | null;
  labels: string[];
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  assignee?: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  } | null;
  assigner?: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  } | null;
}

interface TaskViewProps {
  pageId: string;
  title: string;
  content: string;
  driveId: string;
  onUpdate?: () => void;
}

export default function TaskView({ pageId, title, content, driveId, onUpdate }: TaskViewProps) {
  const [metadata, setMetadata] = useState<TaskMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTaskMetadata();
  }, [pageId]);

  const loadTaskMetadata = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/tasks/${pageId}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to load task metadata');
      }

      const data = await response.json();
      setMetadata(data.metadata);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task');
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (newStatus: TaskMetadata['status']) => {
    try {
      const response = await fetch(`/api/tasks/${pageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus }),
      });

      if (!response.ok) {
        throw new Error('Failed to update task status');
      }

      await loadTaskMetadata();
      onUpdate?.();
    } catch (err) {
      console.error('Error updating task status:', err);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
          <div className="h-4 bg-gray-200 rounded w-1/3"></div>
        </div>
      </div>
    );
  }

  if (error || !metadata) {
    return (
      <div className="p-6">
        <div className="text-red-600">Error: {error || 'Task not found'}</div>
      </div>
    );
  }

  const statusColors = {
    pending: 'bg-gray-100 text-gray-800',
    in_progress: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    blocked: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };

  const priorityColors = {
    low: 'bg-gray-100 text-gray-600',
    medium: 'bg-yellow-100 text-yellow-800',
    high: 'bg-orange-100 text-orange-800',
    urgent: 'bg-red-100 text-red-800',
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-4">{title}</h1>

        <div className="flex flex-wrap gap-2 mb-4">
          {/* Status Badge */}
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${statusColors[metadata.status]}`}>
            {metadata.status.replace('_', ' ').toUpperCase()}
          </span>

          {/* Priority Badge */}
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${priorityColors[metadata.priority]}`}>
            {metadata.priority.toUpperCase()} PRIORITY
          </span>
        </div>
      </div>

      {/* Task Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Assignee */}
        <div>
          <h3 className="text-sm font-semibold text-gray-600 mb-2">Assigned To</h3>
          {metadata.assignee ? (
            <div className="flex items-center gap-2">
              {metadata.assignee.image && (
                <img
                  src={metadata.assignee.image}
                  alt={metadata.assignee.name}
                  className="w-8 h-8 rounded-full"
                />
              )}
              <div>
                <div className="font-medium">{metadata.assignee.name}</div>
                <div className="text-sm text-gray-500">{metadata.assignee.email}</div>
              </div>
            </div>
          ) : (
            <div className="text-gray-500">Unassigned</div>
          )}
        </div>

        {/* Assigner */}
        <div>
          <h3 className="text-sm font-semibold text-gray-600 mb-2">Created By</h3>
          {metadata.assigner && (
            <div className="flex items-center gap-2">
              {metadata.assigner.image && (
                <img
                  src={metadata.assigner.image}
                  alt={metadata.assigner.name}
                  className="w-8 h-8 rounded-full"
                />
              )}
              <div>
                <div className="font-medium">{metadata.assigner.name}</div>
                <div className="text-sm text-gray-500">{metadata.assigner.email}</div>
              </div>
            </div>
          )}
        </div>

        {/* Due Date */}
        {metadata.dueDate && (
          <div>
            <h3 className="text-sm font-semibold text-gray-600 mb-2">Due Date</h3>
            <div className="font-medium">
              {new Date(metadata.dueDate).toLocaleDateString()}
            </div>
          </div>
        )}

        {/* Start Date */}
        {metadata.startDate && (
          <div>
            <h3 className="text-sm font-semibold text-gray-600 mb-2">Start Date</h3>
            <div className="font-medium">
              {new Date(metadata.startDate).toLocaleDateString()}
            </div>
          </div>
        )}

        {/* Estimated Hours */}
        {metadata.estimatedHours !== null && (
          <div>
            <h3 className="text-sm font-semibold text-gray-600 mb-2">Estimated Hours</h3>
            <div className="font-medium">{metadata.estimatedHours}h</div>
          </div>
        )}

        {/* Actual Hours */}
        {metadata.actualHours !== null && (
          <div>
            <h3 className="text-sm font-semibold text-gray-600 mb-2">Actual Hours</h3>
            <div className="font-medium">{metadata.actualHours}h</div>
          </div>
        )}
      </div>

      {/* Labels */}
      {metadata.labels.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-600 mb-2">Labels</h3>
          <div className="flex flex-wrap gap-2">
            {metadata.labels.map((label, index) => (
              <span
                key={index}
                className="px-2 py-1 bg-indigo-100 text-indigo-800 text-sm rounded"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      {content && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-600 mb-2">Description</h3>
          <div className="prose max-w-none">
            <p className="text-gray-700 whitespace-pre-wrap">{content}</p>
          </div>
        </div>
      )}

      {/* Status Update Buttons */}
      <div className="border-t pt-6">
        <h3 className="text-sm font-semibold text-gray-600 mb-3">Update Status</h3>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => updateStatus('pending')}
            disabled={metadata.status === 'pending'}
            className="px-4 py-2 bg-gray-100 text-gray-800 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Pending
          </button>
          <button
            onClick={() => updateStatus('in_progress')}
            disabled={metadata.status === 'in_progress'}
            className="px-4 py-2 bg-blue-100 text-blue-800 rounded hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            In Progress
          </button>
          <button
            onClick={() => updateStatus('completed')}
            disabled={metadata.status === 'completed'}
            className="px-4 py-2 bg-green-100 text-green-800 rounded hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Completed
          </button>
          <button
            onClick={() => updateStatus('blocked')}
            disabled={metadata.status === 'blocked'}
            className="px-4 py-2 bg-red-100 text-red-800 rounded hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Blocked
          </button>
          <button
            onClick={() => updateStatus('cancelled')}
            disabled={metadata.status === 'cancelled'}
            className="px-4 py-2 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancelled
          </button>
        </div>
      </div>

      {/* Metadata Footer */}
      <div className="mt-6 pt-6 border-t text-sm text-gray-500">
        <div>Created: {new Date(metadata.createdAt).toLocaleString()}</div>
        <div>Last updated: {new Date(metadata.updatedAt).toLocaleString()}</div>
        {metadata.completedAt && (
          <div>Completed: {new Date(metadata.completedAt).toLocaleString()}</div>
        )}
      </div>
    </div>
  );
}
