/**
 * Pins the web app's security-audit alert wiring.
 *
 * `alertHandler` in security-audit-alerting.ts is a module-local variable, so
 * every process that raises trust-plane alerts must register its own handler.
 * Before this wiring existed, `setChainAlertHandler` had no caller anywhere and
 * every notify* helper early-returned — the alerting interface was complete and
 * delivered nothing. This process raises them via cron/verify-audit-chain
 * (verifyAndAlert, notifyAnchorVerificationFailure, notifyAnchorReceiptsMissing)
 * and via notifyAdminDbBreakGlass on any audit write.
 *
 * The handler's behaviour is tested once in
 * packages/lib/src/audit/__tests__/chain-alert-payload.test.ts — the single
 * implementation all three processes share. What only a pin can catch is the
 * registration being dropped, and instrumentation.ts cannot be imported in a
 * unit test (register() pulls in the Sentry config, env validation, ClickHouse
 * probe and DB-backed hooks), so this asserts on source.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const source = readFileSync(path.resolve(__dirname, '../instrumentation.ts'), 'utf8');

describe('web instrumentation — chain alert composition-root wiring', () => {
  it('registers a chain alert handler', () => {
    expect(source).toContain('setChainAlertHandler(');
    expect(source).toContain('buildChainAlertHandler(');
  });

  it('tags its alerts as coming from the web process', () => {
    expect(source).toMatch(/buildChainAlertHandler\([\s\S]*?'web'\s*\)/);
  });

  it('captures through Sentry', () => {
    expect(source).toMatch(/Sentry\.captureException\(error, context\)/);
  });

  it('registers inside the nodejs runtime branch, not the edge one', () => {
    const nodeBranch = source.indexOf("process.env.NEXT_RUNTIME === \"nodejs\"");
    const edgeBranch = source.indexOf("process.env.NEXT_RUNTIME === \"edge\"");
    const register = source.indexOf('setChainAlertHandler(');

    expect(nodeBranch).toBeGreaterThan(-1);
    expect(edgeBranch).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(nodeBranch);
    expect(register).toBeLessThan(edgeBranch);
  });
});
