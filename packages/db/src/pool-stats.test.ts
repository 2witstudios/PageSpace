import { describe, it, expect, beforeEach } from 'vitest';
import EventEmitter from 'events';
import { registerPoolEvents, getPoolStats } from './pool-stats';

describe('pool-stats', () => {
  describe('getPoolStats', () => {
    it('returns zeros when no events have fired', () => {
      const mockPool = new EventEmitter();
      registerPoolEvents(mockPool);
      expect(getPoolStats()).toEqual({ total: 0, idle: 0, waiting: 0 });
    });
  });

  describe('registerPoolEvents', () => {
    let mockPool: EventEmitter;

    beforeEach(() => {
      mockPool = new EventEmitter();
      registerPoolEvents(mockPool);
    });

    it('increments total by 1 per connect event', () => {
      mockPool.emit('connect');
      mockPool.emit('connect');
      mockPool.emit('connect');
      expect(getPoolStats().total).toBe(3);
    });

    it('decrements total when remove fires after connects', () => {
      mockPool.emit('connect');
      mockPool.emit('connect');
      mockPool.emit('connect');
      mockPool.emit('remove');
      expect(getPoolStats().total).toBe(2);
    });

    it('decrements idle when acquire fires', () => {
      mockPool.emit('connect');
      const before = getPoolStats().idle;
      mockPool.emit('acquire');
      expect(getPoolStats().idle).toBe(before - 1);
    });

    it('restores idle to initial value after acquire and release', () => {
      mockPool.emit('connect');
      const initial = getPoolStats().idle;
      mockPool.emit('acquire');
      mockPool.emit('release', undefined);
      expect(getPoolStats().idle).toBe(initial);
    });
  });
});
