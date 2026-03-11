/**
 * @module @pagespace/lib/sheets
 * @description Spreadsheet logic and evaluation
 *
 * This module re-exports from focused submodules for better maintainability.
 * All exports are backwards compatible with the original monolithic implementation.
 */

// Re-export everything from submodules
export * from './constants';
export * from './types';
export * from './address';
export * from './parser';
export * from './functions';
export * from './evaluation';
export * from './io';
export * from './external';
export * from './update';
