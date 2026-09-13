/**
 * Leaf F — the posture document, the customer page, the settings copy and the
 * changelog say what the code does, and say its limits.
 *
 * A documentation test earns its place here for the same reason
 * `tool-registry-docs.test.ts` does: these claims are the ones a reader acts on
 * — an operator deciding whether to flip a flag, a person deciding whether to
 * switch their own computer on for an agent — and a claim that drifts from the
 * code is worse than no claim. Every assertion below is a Given/Should from the
 * leaf's own page.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '../../../../../../..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

const posture = read('docs/security/local-environment-bridge.md');
const customerPage = read('apps/marketing/src/app/docs/security/local-environments/page.tsx');
const changelog = read('CHANGELOG.md');
const settingsCopy = read('apps/web/src/components/settings/GlobalAssistantVisibilityToggle.tsx');

describe('the posture document', () => {
  it('records that the global assistant can now reach environments the owner made visible', () => {
    expect(posture).toContain('## The global assistant reaches environments it may see');
    expect(posture).toMatch(/visibleToGlobalAssistant/);
    // [D-4] must no longer read as deferred — it is the decision this closed.
    expect(posture).toMatch(/\[D-4\] A global assistant cannot reach any environment\.\*\* \*\*RESOLVED/);
  });

  it('states plainly that it is the agent most exposed to injection, and WHY — its context spans every drive', () => {
    expect(posture).toMatch(/most exposed to prompt injection/i);
    expect(posture).toMatch(/context spans every\s+drive/);
  });

  it('records the decision behind the mandatory opaque id, including the July evidence', () => {
    expect(posture).toMatch(/### Why addressing is mandatory and opaque/);
    // The evidence: an optional free-text target, invented by the model, removed two days later.
    expect(posture).toContain('cf576fbc1');
    expect(posture).toMatch(/removed\s+two\s*\n?\s*days later/);
    expect(posture).toMatch(/branch: "main"/);
    expect(posture).toMatch(/\*\*omission is a validation error\*\*/);
  });

  it('names session-level taint as the REMAINING GAP rather than leaving it implied', () => {
    expect(posture).toMatch(/### The remaining gap: session-level taint/);
    expect(posture).toMatch(/\| R-16 \| \*\*No session-level taint/);
    // And says what it is not a control on, so nobody reads the phase as closing it.
    expect(posture).toMatch(/Neither is a control on what the\s*\n?\s*assistant was persuaded to want/);
  });

  it('records the founder ruling and the canRunCode parity for CLOUD envs, and says the local rule is unchanged', () => {
    expect(posture).toMatch(/### Two substrates, two authorities/);
    expect(posture).toMatch(/if the user can, their global assistant should be able to/);
    expect(posture).toMatch(/the DRIVE PERMISSION\s*\n?\s*is the visibility/);
    expect(posture).toMatch(/A VIEWER is refused here exactly as they are in-drive/);
    expect(posture).toMatch(/A LOCAL machine keeps its own rule, unchanged/);
    // The parity promise is a test, and the document says so.
    expect(posture).toMatch(/parity promise is a TEST, not a comment/);
  });

  it('no longer claims the feature is LOCAL-ONLY anywhere', () => {
    expect(posture).not.toMatch(/LOCAL-ONLY|local-only/);
  });

  it('names the new blast radius in the register — aggregation, not per-drive escalation', () => {
    expect(posture).toMatch(/\| R-20 \| \*\*The global assistant's blast radius/);
    expect(posture).toMatch(/it is parity, not escalation/);
    expect(posture).toMatch(/What CHANGES is the AGGREGATION/);
  });

  it('says the database CHECK was DROPPED, why it was right for a Sprite env and wrong for a local one, and where the guarantee lives now', () => {
    // The most consequential change in the phase: a constraint that cannot be
    // got wrong became two code branches that can. An auditor and the founder
    // read THIS document, not the schema file — so it may not be silent here.
    expect(posture).toMatch(/### The database CHECK that was dropped, and why/);
    expect(posture).toMatch(/agent_workspaces_env_needs_drive_check/);
    expect(posture).toMatch(/0296/);
    // Right about one substrate, wrong about the other — both said.
    expect(posture).toMatch(/right about a Sprite env and wrong about a local one/);
    expect(posture).toMatch(/that arm is still enforced/);
    // And where it lives now.
    expect(posture).toMatch(/\*\*Where the guarantee lives now:\*\*/);
  });

  it('carries the routing row in the LAYERS table naming both branches, and the residual in the REGISTER', () => {
    const layers = posture.slice(posture.indexOf('| Layer | Where |'), posture.indexOf('In SSH terms'));
    expect(layers).toMatch(/\| Drive agreement on an env-bound session/);
    expect(layers).toMatch(/gateLocalEnvBind/);
    expect(layers).toMatch(/env\.driveId === driveId/);
    expect(layers).toMatch(/DROPPED/);
    expect(posture).toMatch(/\| R-18 \| \*\*A database CHECK became two code branches/);
  });

  it('adds to the layers table, the residual register and the flag-on checklist', () => {
    expect(posture).toMatch(/\| Visibility to the global assistant — a LOCAL-machine opt-in \|/);
    expect(posture).toMatch(/\| A CLOUD env reaches by `canRunCode` PARITY \|/);
    expect(posture).toMatch(/\| Mandatory, opaque environment id on every code-execution tool \|/);
    expect(posture).toMatch(/\| The result says where it ran \|/);
    expect(posture).toMatch(/\| R-17 \| \*\*A REAL id for the WRONG environment/);
    expect(posture).toMatch(/11\. The global assistant's reach is off by default and unguessable/);
    expect(posture).toMatch(/12\. Omission and invention both fail/);
  });
});

describe('the customer page does not read better than the internal document', () => {
  it('carries the same limit the posture document does: visibility is not authority, and the click still stands', () => {
    expect(customerPage).toMatch(/cannot see your machine until you say so/);
    expect(customerPage).toMatch(/does not widen who may drive the machine/);
    expect(customerPage).toMatch(/still waits for\s*\n?\s*your click/);
  });

  it('says a cloud environment needs no switch, and that the limit is what you can already do there', () => {
    expect(customerPage).toMatch(/nothing to switch on/i);
    expect(customerPage).toMatch(/exactly what you\s*\n?\s*could already do in those drives yourself/i);
    expect(customerPage).toMatch(/it can still name the wrong one/);
  });

  it('names the taint gap in the customer\'s own words rather than omitting it', () => {
    expect(customerPage).toMatch(/Nothing treats a conversation as tainted by what it has read/);
    expect(customerPage).toMatch(/honest remaining gap/);
  });

  it('every claim it makes about this feature has a limit beside it', () => {
    // The page's own rule: each guarantee is followed by its exact limit. The
    // new bullet obeys it.
    const bullet = customerPage.slice(customerPage.indexOf('cannot see your machine until you say so'));
    expect(bullet.slice(0, 1400)).toMatch(/\*Limit, and read\s*\n?\s*it carefully:/);
  });
});

describe('the settings copy', () => {
  it('says what turning it on actually permits, then its exact limit — the register the CLI README uses', () => {
    expect(settingsCopy).toMatch(/Off by default/);
    expect(settingsCopy).toMatch(/see this machine and name it when it runs/);
    // The limit, in the same breath.
    expect(settingsCopy).toMatch(/It does not widen who may drive the machine/);
    expect(settingsCopy).toMatch(/still waits for your click/);
  });
});

describe('the changelog', () => {
  it('tells a person what they must TURN ON for any of this to happen', () => {
    const entry = changelog.slice(0, changelog.indexOf('a file write that could become a command'));
    expect(entry).toMatch(/You have to turn it on, per machine/);
    expect(entry).toMatch(/Settings → Local\s*\n?\s*environments/);
    expect(entry).toMatch(/Let your global assistant use this machine/);
    expect(entry).toMatch(/Every machine starts off/);
  });

  it('tells a person the CLOUD half needs nothing turned on, and names the shape change', () => {
    const entry = changelog.slice(0, changelog.indexOf('a file write that could become a command'));
    expect(entry).toMatch(/There is nothing to turn on/);
    expect(entry).toMatch(/if you can run code there, so can it/);
    expect(entry).toMatch(/refused exactly as you are/);
    // The honest framing: a change in shape, not in permissions.
    expect(entry).toMatch(/It can do nothing in any drive that you could not\s*\n?\s*already do there yourself/);
  });

  it('still carries the LOCAL limit — the machine switch and the click', () => {
    const entry = changelog.slice(0, changelog.indexOf('a file write that could become a command'));
    expect(entry).toMatch(/does not widen who may drive the machine/);
    expect(entry).toMatch(/passkey-verified click/);
  });
});
