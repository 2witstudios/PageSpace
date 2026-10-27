import { Drive } from '@/hooks/useDrive';
import { isHomeDrive } from '@pagespace/lib/services/drive-guards';

/** Puts the single Home drive (kind='HOME') first; all others follow in their
 *  original order. Treats undefined kind as STANDARD (stale cache safety). */
export function pinHomeFirst(drives: Drive[]): Drive[] {
  const homeIdx = drives.findIndex(d => isHomeDrive(d));
  if (homeIdx <= 0) return [...drives];
  const result = [...drives];
  const [home] = result.splice(homeIdx, 1);
  result.unshift(home);
  return result;
}
