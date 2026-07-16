/**
 * Shared zod fields for the tool-table rows.
 */
import { z } from 'zod';
import { MAX_PATH_LENGTH } from '../../sandbox-tools';

// Optional per-call working directory, relative to the sandbox root (/workspace).
// Each tool call is a fresh process, so cwd never persists between calls — pass it
// to operate inside a cloned subdirectory. The runner validates it (path_escape).
export const cwdField = z.string().max(MAX_PATH_LENGTH).optional();
