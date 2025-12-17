'use client';

import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface WelcomeContentProps {
  /** Title text displayed above the input */
  title?: string;
  /** Subtitle text displayed below the title */
  subtitle?: string;
  /** Optional icon component to display - defaults to Sparkles */
  icon?: React.ReactNode;
  /** Whether to show the icon */
  showIcon?: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * WelcomeContent - The welcome content displayed above the centered input
 * when there are no messages in the conversation.
 *
 * Features staggered entrance animations for a polished, premium feel.
 */
export function WelcomeContent({
  title = 'How can I help you today?',
  subtitle,
  icon,
  showIcon = true,
  className,
}: WelcomeContentProps) {
  const shouldReduceMotion = useReducedMotion();

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: shouldReduceMotion ? 0 : 0.08,
        delayChildren: shouldReduceMotion ? 0 : 0.1,
      },
    },
  };

  const itemVariants = {
    hidden: shouldReduceMotion
      ? { opacity: 0 }
      : { opacity: 0, y: 12 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: shouldReduceMotion ? 0 : 0.4,
        ease: [0.25, 0.1, 0.25, 1] as const,
      },
    },
  };

  const iconVariants = {
    hidden: shouldReduceMotion
      ? { opacity: 0 }
      : { opacity: 0, scale: 0.8 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: {
        duration: shouldReduceMotion ? 0 : 0.5,
        ease: [0.25, 0.1, 0.25, 1] as const,
      },
    },
  };

  // Breathing animation for the icon
  const iconBreathingAnimation = shouldReduceMotion
    ? {}
    : {
        opacity: [0.7, 1, 0.7],
        scale: [1, 1.05, 1],
      };

  const iconBreathingTransition = shouldReduceMotion
    ? {}
    : {
        duration: 3,
        repeat: Infinity,
        ease: 'easeInOut' as const,
      };

  const defaultIcon = (
    <motion.div
      animate={iconBreathingAnimation}
      transition={iconBreathingTransition}
      className="p-4 rounded-full bg-primary/10"
    >
      <Sparkles className="h-8 w-8 text-primary" />
    </motion.div>
  );

  return (
    <motion.div
      className={cn(
        'flex flex-col items-center text-center mb-6',
        className
      )}
      initial="hidden"
      animate="visible"
      variants={containerVariants}
    >
      {/* Icon */}
      {showIcon && (
        <motion.div
          className="mb-4"
          variants={iconVariants}
        >
          {icon || defaultIcon}
        </motion.div>
      )}

      {/* Title */}
      <motion.h2
        className="text-2xl font-semibold text-foreground tracking-tight"
        variants={itemVariants}
      >
        {title}
      </motion.h2>

      {/* Subtitle */}
      {subtitle && (
        <motion.p
          className="mt-2 text-muted-foreground text-sm max-w-md"
          variants={itemVariants}
        >
          {subtitle}
        </motion.p>
      )}
    </motion.div>
  );
}
