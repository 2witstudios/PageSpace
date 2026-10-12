import path from 'node:path';

/** Where scripts/render-imago-boards.mjs writes the boards' reference PNGs (DEC-C3). */
export const BOARD_REFERENCE_DIR = path.resolve(__dirname, '..', '..', 'imago-boards');

/**
 * The committed reference PNG for a design board, or for one of its states
 * (`Board@state.png`). Only board-shaped names resolve, so a spec cannot attach an arbitrary file.
 */
export const boardReference = (board: string, state?: string): string => {
  if (!/^[A-Z][A-Za-z0-9-]*$/.test(board) || (state !== undefined && !/^[a-z0-9-]+$/.test(state))) {
    throw new Error(`not a board: ${board}${state === undefined ? '' : `@${state}`}`);
  }
  return path.join(BOARD_REFERENCE_DIR, `${state === undefined ? board : `${board}@${state}`}.png`);
};
