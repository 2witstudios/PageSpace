import path from 'path';
import fs from 'fs';

export interface SeedState {
  userId: string;
  driveId: string;
}

function loadSeedState(): SeedState {
  const filePath = path.resolve(__dirname, '../.seed-state.json');
  if (!fs.existsSync(filePath)) {
    throw new Error('.seed-state.json not found — did global-setup run?');
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<SeedState>;
  if (typeof parsed.userId !== 'string' || typeof parsed.driveId !== 'string') {
    throw new Error('.seed-state.json is malformed — userId/driveId missing');
  }
  return parsed as SeedState;
}

export const seedState: SeedState = loadSeedState();
