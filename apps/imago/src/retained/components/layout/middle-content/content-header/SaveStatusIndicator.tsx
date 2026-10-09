'use client';

import { motion } from 'motion/react';

interface SaveStatusIndicatorProps {
  isDirty: boolean;
  isSaving: boolean;
}

export function SaveStatusIndicator({ isDirty, isSaving }: SaveStatusIndicatorProps) {
  if (isSaving) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
        Saving...
      </motion.div>
    );
  }
  
  if (isDirty) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <div className="w-2 h-2 bg-orange-500 rounded-full" />
        Unsaved changes
      </motion.div>
    );
  }
  
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex items-center gap-1 text-xs text-green-600"
    >
      <div className="w-2 h-2 bg-green-500 rounded-full" />
      Saved
    </motion.div>
  );
}