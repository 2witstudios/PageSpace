/**
 * Live server-side acceptance for the PageSpace Agent pane (epic #2166).
 * Seeds user+drive+MACHINE page + session against a DISPOSABLE local DB, then
 * drives the real running app (:3000) via authenticated fetches — real routes,
 * real Postgres, real auth. Covers the non-Sprite acceptance criteria that live
 * at the server contract (pane exists, shared conversation, independent panes,
 * close-pane). Sprite-dependent tool execution is NOT covered here.
 */
import 'dotenv/config';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '../../packages/lib/src/auth/session-service';
import { generateCSRFToken } from '../../packages/lib/src/auth/csrf-utils';
import { db } from '@pagespace/db/db';
import { conversations } from '@pagespace/db/schema/conversations';
import { machineProjects } from '@pagespace/db/schema/machine-projects';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { eq } from '@pagespace/db/operators';
import { deriveMachinePaneBinding } from '../../packages/lib/src/services/machines/machine-pane-binding';
import { buildMachinePaneBindingDeps } from '../../apps/web/src/lib/ai/machine-pane/machine-pane-binding-runtime';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function main() {
  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  const machine = await factories.createPage(drive.id, { type: 'MACHINE', title: 'accept-machine' });
  await factories.createPagePermission(machine.id, user.id, { canView: true, canEdit: true });
  const token = await sessionService.createSession({ userId: user.id, type: 'user', scopes: [], expiresInMs: 3600_000 });
  const claims = await sessionService.validateSession(token);
  const csrf = generateCSRFToken(claims!.sessionId);
  const H = { 'content-type': 'application/json', cookie: `session=${token}`, 'x-csrf-token': csrf };

  // Seed a project + branch so the project/branch scopes resolve (spawn reserves a row; never touches a Sprite)
  await db.insert(machineProjects).values({ ownerId: user.id, machineId: machine.id, name: 'accept-proj', repoUrl: 'https://example.com/r.git', path: '/repo' });
  await db.insert(machineBranches).values({ ownerId: user.id, machineId: machine.id, projectName: 'accept-proj', branchName: 'accept-branch', sessionKey: `accept-${machine.id}`, sandboxId: 'seed-sprite-id' });

  // AC-A: spawn a PageSpace Agent pane at machine scope (flag on) → row with id
  const spawn = await fetch(`${BASE}/api/machines/agent-terminals`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ machineId: machine.id, name: 'accept-pane-1', agentType: 'pagespace' }),
  });
  const spawnBody: any = await spawn.json().catch(() => ({}));
  check('AC-A spawn pagespace pane → 2xx + row id', spawn.ok && !!spawnBody.agentTerminal?.id, `status=${spawn.status} id=${spawnBody.agentTerminal?.id ?? 'none'}`);
  const rowId = spawnBody.agentTerminal?.id;

  // AC-B: shared conversation pre-created for the row (multi-viewer parity)
  if (rowId) {
    const conv = await db.select().from(conversations).where(eq(conversations.id, rowId));
    check('AC-B shared conversation pre-created (isShared)', conv.length === 1 && conv[0].isShared === true,
      `found=${conv.length} isShared=${conv[0]?.isShared}`);
  } else check('AC-B shared conversation pre-created (isShared)', false, 'no rowId');

  // AC-C: GET list includes the pagespace row with its id
  const list = await fetch(`${BASE}/api/machines/agent-terminals?machineId=${machine.id}`, { headers: H });
  const listBody: any = await list.json().catch(() => ({}));
  const found = (listBody.agentTerminals ?? []).find((t: any) => t.id === rowId && t.agentType === 'pagespace');
  check('AC-C GET list includes pagespace pane', !!found, `count=${(listBody.agentTerminals ?? []).length}`);

  // AC-D: a second pane is an independent row/conversation
  const spawn2 = await fetch(`${BASE}/api/machines/agent-terminals`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ machineId: machine.id, name: 'accept-pane-2', agentType: 'pagespace' }),
  });
  const spawn2Body: any = await spawn2.json().catch(() => ({}));
  check('AC-D two panes = independent conversations', spawn2.ok && !!spawn2Body.agentTerminal?.id && spawn2Body.agentTerminal?.id !== rowId,
    `id2=${spawn2Body.agentTerminal?.id ?? 'none'}`);

  // AC-E: closing a pane removes the row; the conversation survives
  if (rowId) {
    const del = await fetch(`${BASE}/api/machines/agent-terminals?machineId=${machine.id}&name=accept-pane-1`, {
      method: 'DELETE', headers: H,
    });
    const listAfter = await fetch(`${BASE}/api/machines/agent-terminals?machineId=${machine.id}`, { headers: H });
    const listAfterBody: any = await listAfter.json().catch(() => ({}));
    const stillThere = (listAfterBody.agentTerminals ?? []).some((t: any) => t.id === rowId);
    const conv = await db.select().from(conversations).where(eq(conversations.id, rowId));
    check('AC-E close pane → row gone, conversation survives', del.ok && !stillThere && conv.length === 1,
      `delStatus=${del.status} rowGone=${!stillThere} convSurvives=${conv.length === 1}`);
  } else check('AC-E close pane → row gone, conversation survives', false, 'no rowId');

  // AC-F: PageSpace Agent pane at PROJECT scope ("works for machine, project, and branch workspaces")
  const proj = await fetch(`${BASE}/api/machines/agent-terminals`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ machineId: machine.id, projectName: 'accept-proj', name: 'proj-pane', agentType: 'pagespace' }),
  });
  const projBody: any = await proj.json().catch(() => ({}));
  check('AC-F spawn PageSpace Agent at PROJECT scope', proj.ok && !!projBody.agentTerminal?.id,
    `status=${proj.status} id=${projBody.agentTerminal?.id ?? 'none'}`);

  // AC-G: PageSpace Agent pane at BRANCH scope (projectName + branchName)
  const br = await fetch(`${BASE}/api/machines/agent-terminals`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ machineId: machine.id, projectName: 'accept-proj', branchName: 'accept-branch', name: 'branch-pane', agentType: 'pagespace' }),
  });
  const brBody: any = await br.json().catch(() => ({}));
  check('AC-G spawn PageSpace Agent at BRANCH scope', br.ok && !!brBody.agentTerminal?.id,
    `status=${br.status} id=${brBody.agentTerminal?.id ?? 'none'}`);

  // Server-derived binding checks (mode-switch + "machine bindings server-derived, never trusted from client")
  const bindRowId = projBody.agentTerminal?.id; // a live (non-deleted) machine-page-anchored pagespace row
  const bindDeps = buildMachinePaneBindingDeps();
  // AC-H: default mode — machine-anchored conversation derives a server binding pinned to the machine
  const bH: any = await deriveMachinePaneBinding({ chatId: machine.id, conversationId: bindRowId }, bindDeps);
  check('AC-H default mode → server-derived machine binding (cwd pinned)', bH?.ok === true && typeof bH?.binding?.cwd === 'string' && bH.binding.cwd.length > 0,
    `ok=${bH?.ok} cwd=${bH?.binding?.cwd ?? 'none'}`);
  // AC-I: client-supplied chatId mismatch → fail-closed (binding never trusted from the client)
  const bI: any = await deriveMachinePaneBinding({ chatId: 'not-this-machine', conversationId: bindRowId }, bindDeps);
  check('AC-I client-mismatched chatId → fail-closed (not trusted from client)', bI?.ok === false && bI?.reason === 'binding_page_mismatch',
    `ok=${bI?.ok} reason=${bI?.reason ?? 'none'}`);

  // AC-J: reload/restore — the pane's conversation is loadable via the messages API (survives reload)
  const msgs = await fetch(`${BASE}/api/ai/page-agents/${machine.id}/conversations/${bindRowId}/messages`, { headers: H });
  check('AC-J reload → conversation loadable via messages API', msgs.status === 200, `status=${msgs.status}`);

  // AC-L: agent mode — a conversation with no machine-terminal row is NOT machine-bound (switching to a page agent)
  const bL: any = await deriveMachinePaneBinding({ chatId: machine.id, conversationId: 'no-such-terminal-row' }, bindDeps);
  check('AC-L agent mode / non-machine conversation → no binding (null)', bL === null, `result=${JSON.stringify(bL)}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} live server-side acceptance checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error('ACCEPTANCE SCRIPT ERROR:', e); process.exit(2); });
