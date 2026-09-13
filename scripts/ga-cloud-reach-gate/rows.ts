/**
 * The cloud-reach exit gate's rows, driven through the REAL chat API exactly as
 * the browser sends it (session cookie + `X-CSRF-Token` + matching `Origin`).
 *
 * Read `./README.md` first. Two properties this file exists to preserve:
 *
 *  - **Every permission change goes through the API a person uses**
 *    (`PATCH /api/drives/<id>/members/<userId>`), never `psql`. A gate that
 *    reaches past the application to arrange its own preconditions is testing a
 *    database, not a product — and rows 5/6 are precisely about the product
 *    honouring a permission change.
 *  - **`expected` is the exact value**, never a category, because a category
 *    assertion passes on the wrong refusal.
 *
 * Required env:
 *   GATE_BASE_URL   the running app's origin (also sent as `Origin`). LOOPBACK ONLY —
 *                   see `./local-origin.ts` for why the gate refuses anything else.
 *   seed JSON path  argv[2], from `seed-gate.ts`
 *
 *   GATE_BASE_URL=http://localhost:3000 bun scripts/ga-cloud-reach-gate/rows.ts seed.json
 */
import { readFileSync } from 'node:fs';
import { expect, failed, record, required, summarize } from '../env-bridge-exit-gate/report.ts';
import { gateUrl, resolveLocalGateOrigin } from './local-origin.ts';

/**
 * LOOPBACK ONLY, decided before anything is read or sent.
 *
 * The seed this script loads carries real session cookies, so a mistyped
 * `GATE_BASE_URL` would ship them off the machine. `resolveLocalGateOrigin`
 * throws here — before `readFileSync`, before any `fetch` — and returns an
 * origin rebuilt from literals, so the caller's string never reaches a request.
 */
const origin = resolveLocalGateOrigin(required('GATE_BASE_URL'));

interface SeedDrive { driveId: string; envId: string; envName: string; payerId: string; payerSession?: string }
interface Seed {
  u: { userId: string; session: string };
  p: SeedDrive; v: SeedDrive; x: SeedDrive;
  agentPageId: string;
  /** Seeded, because the gate may not reach past the application to invent its own preconditions. */
  pageConversationId: string;
  /** The role R6 demotes U to inside drive P. */
  pViewOnlyRoleId: string;
}

interface Answer { code: number; json: Record<string, unknown> | null; text: string }

async function call(path: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(gateUrl(origin, path), { redirect: 'manual', ...init });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
  } catch { json = null; }
  return { code: response.status, json, text };
}

const cookieFor = (session: string) => `pagespace_session=${session}`;

/** A write as the browser sends it: cookie, CSRF token, and a matching Origin. */
async function authedWrite(path: string, session: string, body: unknown, method = 'POST'): Promise<Answer> {
  const csrf = await call('/api/auth/csrf', { headers: { cookie: cookieFor(session) } });
  const token = typeof csrf.json?.csrfToken === 'string' ? csrf.json.csrfToken : '';
  return call(path, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookieFor(session), 'X-CSRF-Token': token, origin },
    body: JSON.stringify(body),
  });
}

/**
 * Drive one global-assistant turn and return the whole streamed transcript.
 *
 * The prompt NAMES the tool and the id, because the gate is about what the
 * SERVER does with a given environment id, not about whether a model chooses
 * to reach for a tool. A turn where the model simply declined would prove
 * nothing either way — the same honesty the M1 gate recorded for `P16a`.
 */
async function turn(session: string, conversationId: string, prompt: string): Promise<string> {
  const answer = await authedWrite('/api/ai/chat', session, {
    conversationId,
    messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
  });
  return answer.text;
}

/** Did the transcript carry this environment id as a LISTED row (not merely echoed in prose)? */
const listed = (transcript: string, envId: string) => transcript.includes(`"id":"${envId}"`);

async function main() {
  const seed = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Seed;
  const { u, p, v, x } = seed;

  // A global conversation is the dashboard assistant's own surface.
  const created = await authedWrite('/api/ai/global', u.session, {});
  const conversationId = typeof created.json?.id === 'string' ? created.json.id : '';
  if (!conversationId) {
    failed('R0', 'a global conversation', created.text.slice(0, 200), 'could not open a dashboard conversation');
    process.exit(summarize('cloud-reach rows'));
  }
  record({ id: 'R0', status: 'PASS', expected: 'conversation', actual: conversationId, note: 'dashboard global conversation opened' });

  // R1 — discovery lists exactly what the person may use.
  const discovery = await turn(u.session, conversationId, 'Call list_environments and show me every environment you can use.');
  expect('R1a', true, listed(discovery, p.envId), `p-env (${p.envName}) IS listed — U can run code in drive P`);
  expect('R1b', false, listed(discovery, v.envId), 'v-env is NOT listed — U is view-only in drive V');
  expect('R1c', false, listed(discovery, x.envId), 'x-env is NOT listed — U is not a member of drive X');

  // R2 — it runs on the REAL Sprite. `-fly` in `uname -a` is the proof: the
  // kernel string of a Fly microVM, which the conversation's own sandbox would
  // also show, so R2b (the session's drive) is what distinguishes them.
  const ran = await turn(
    u.session,
    conversationId,
    `Call bash with environmentId "${p.envId}" and command "uname -a && hostname". Report the exact output.`,
  );
  expect('R2a', true, /-fly/.test(ran), 'the command ran on a real Sprite (uname shows the Fly kernel)');
  expect('R2b', true, ran.includes(p.envId), 'the result names the environment it ran in');

  // R3/R4 — a REAL id the person may not use, and a REAL id in a drive they
  // cannot see, are refused with the SAME sentence.
  const viewerAttempt = await turn(u.session, conversationId, `Call bash with environmentId "${v.envId}" and command "uname -a".`);
  const strangerAttempt = await turn(u.session, conversationId, `Call bash with environmentId "${x.envId}" and command "uname -a".`);
  const refused = (t: string) => t.includes('Call list_environments and copy an id from its output exactly');
  expect('R3', true, refused(viewerAttempt), 'v-env refused with the single unreachable message');
  expect('R4', true, refused(strangerAttempt), 'x-env refused with the IDENTICAL message');

  // R5 — the CONTROL. Promote U to an editing member of V through the real API.
  // Without this, R3 could be passing because the fixture was broken.
  const promote = await authedWrite(
    `/api/drives/${v.driveId}/members/${u.userId}`,
    v.payerSession ?? '',
    { role: 'MEMBER', customRoleId: null },
    'PATCH',
  );
  expect('R5a', 200, promote.code, 'V promotes U to an editing member through the members API');
  const afterPromotion = await turn(u.session, conversationId, `Call list_environments, then call bash with environmentId "${v.envId}" and command "uname -a".`);
  expect('R5b', true, listed(afterPromotion, v.envId), 'v-env now LISTS — so R3 was the permission answering, not a broken fixture');
  expect('R5c', false, refused(afterPromotion), 'v-env now RUNS');

  // R6 — revocation mid-conversation. The session for p-env already exists.
  const demoteRole = await authedWrite(
    `/api/drives/${p.driveId}/members/${u.userId}`,
    p.payerSession ?? '',
    { role: 'MEMBER', customRoleId: seed.pViewOnlyRoleId },
    'PATCH',
  );
  expect('R6a', 200, demoteRole.code, 'P demotes U to view-only through the members API');
  const afterRevocation = await turn(u.session, conversationId, `Call bash with environmentId "${p.envId}" and command "uname -a".`);
  expect('R6b', true, refused(afterRevocation), 'the NEXT call to p-env is refused even though the session exists');

  // R7 — a page conversation is not the dashboard assistant. Both UIs post to
  // the same `/api/ai/chat`, which decides from the CONVERSATION rather than
  // the URL, so this is the identical entry with a `type='page'` conversation.
  const pageAttempt = await turn(u.session, seed.pageConversationId, `Call bash with environmentId "${p.envId}" and command "uname -a".`);
  expect('R7', true, refused(pageAttempt), 'a PAGE conversation is refused a cloud env id its own drive owns');

  process.exit(summarize('cloud-reach rows'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
