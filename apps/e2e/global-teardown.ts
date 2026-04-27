import { Pool } from 'pg';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenvConfig({ path: path.resolve(__dirname, '../../.env') });

export default async function globalTeardown() {
  const seedStatePath = path.resolve(__dirname, '.seed-state.json');
  if (!fs.existsSync(seedStatePath)) return;

  const { userId } = JSON.parse(fs.readFileSync(seedStatePath, 'utf-8')) as {
    userId: string;
    driveId: string;
  };

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
  } finally {
    client.release();
    await pool.end();
  }

  for (const file of [seedStatePath, path.resolve(__dirname, 'storageState.json')]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
