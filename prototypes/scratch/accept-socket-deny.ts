/**
 * Live socket-deny acceptance: "blocked terminal connections to chat sessions".
 * Spawns a real pagespace pane, then a socket.io client emits
 * `agent-terminal:connect` for it against the running realtime server — the
 * P3 guard must refuse it with `not_a_pty_agent` (emitted as agent-terminal:error),
 * WITHOUT waking a Sprite. Real DB, real auth token, real socket transport.
 */
import 'dotenv/config';
import { io } from 'socket.io-client';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';

const WEB = 'http://localhost:3000';
const RT = 'http://localhost:3001';

async function main() {
  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  const machine = await factories.createPage(drive.id, { type: 'MACHINE', title: 'sock-machine' });
  await factories.createPagePermission(machine.id, user.id, { canView: true, canEdit: true });
  const token = await sessionService.createSession({ userId: user.id, type: 'user', scopes: [], expiresInMs: 3600_000 });
  const claims = await sessionService.validateSession(token);
  const csrf = generateCSRFToken(claims!.sessionId);

  // Spawn a real pagespace pane row so the socket has a chat-surface target to (be denied) connecting to.
  const spawn = await fetch(`${WEB}/api/machines/agent-terminals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `session=${token}`, 'x-csrf-token': csrf },
    body: JSON.stringify({ machineId: machine.id, name: 'sock-pane', agentType: 'pagespace' }),
  });
  const spawned: any = await spawn.json().catch(() => ({}));
  if (!spawn.ok || !spawned.agentTerminal?.id) { console.log(`FAIL setup: spawn ${spawn.status}`); process.exit(1); }

  const socket = io(RT, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 8000 });
  const outcome: string = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT (no deny, no success)'), 9000);
    socket.on('connect', () => {
      socket.emit('agent-terminal:connect', { machineId: machine.id, name: 'sock-pane', connectionId: 'sock-c1', cols: 80, rows: 24 });
    });
    socket.on('agent-terminal:error', (p: any) => { clearTimeout(timer); resolve('DENY:' + JSON.stringify(p)); });
    socket.on('agent-terminal:ready', () => { clearTimeout(timer); resolve('WRONGLY_CONNECTED'); });
    socket.on('agent-terminal:data', () => { clearTimeout(timer); resolve('WRONGLY_CONNECTED'); });
    socket.on('connect_error', (e) => { clearTimeout(timer); resolve('CONNECT_ERROR:' + e.message); });
  });
  socket.close();

  const denied = outcome.startsWith('DENY:');
  const notPty = outcome.includes('not_a_pty_agent');
  console.log(`socket outcome: ${outcome}`);
  console.log(`${denied ? 'PASS' : 'FAIL'}  AC-K socket agent-terminal:connect on a pagespace session is DENIED${notPty ? ' (not_a_pty_agent)' : ''}`);
  process.exit(denied ? 0 : 1);
}
main().catch((e) => { console.error('ERROR', e); process.exit(2); });
