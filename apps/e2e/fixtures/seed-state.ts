import path from 'path';
import fs from 'fs';

export interface SeedState {
  userId: string;
  driveId: string;
}

export const seedState = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../.seed-state.json'), 'utf-8'),
) as SeedState;
