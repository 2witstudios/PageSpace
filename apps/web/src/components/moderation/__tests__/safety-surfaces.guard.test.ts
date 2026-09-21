/**
 * Guideline 1.2 needs report and block where users meet each other. The pages
 * are too heavy to render here, so this pins the wiring; the behaviour lives in
 * UserSafetyMenu / BlockedUsersList and their own tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(__dirname, '../../../app');
const read = (path: string) => readFileSync(join(APP, path), 'utf8');

describe('report and block surfaces', () => {
  it('given a direct message conversation, should offer report and block for the other person in its header', () => {
    const page = read('dashboard/dms/[conversationId]/page.tsx');
    expect(page).toMatch(/<UserSafetyMenu[\s\S]*?userId=\{otherUser\.id\}[\s\S]*?conversationId=\{/);
  });

  it('given the connections page, should offer block for a connection and list blocked users to unblock', () => {
    const page = read('dashboard/connections/page.tsx');
    expect(page).toMatch(/\/api\/users\/\$\{[^}]+\}\/block/);
    expect(page).toMatch(/<BlockedUsersList\s*\/>/);
  });
});
