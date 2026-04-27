import { EventEmitter } from 'events';

let total = 0;
let idle = 0;
const waiting = 0;

export function registerPoolEvents(pool: EventEmitter): void {
  total = 0;
  idle = 0;

  pool.on('connect', () => {
    total++;
    idle++;
  });

  pool.on('acquire', () => {
    idle--;
  });

  pool.on('release', (err?: Error) => {
    if (!err) {
      idle++;
    }
  });

  pool.on('remove', () => {
    total--;
    if (idle > 0) idle--;
  });
}

export function getPoolStats(): { total: number; idle: number; waiting: number } {
  return { total, idle, waiting };
}
