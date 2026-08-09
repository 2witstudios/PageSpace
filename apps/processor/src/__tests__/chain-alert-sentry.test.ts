/**
 * Pins the processor's security-audit alert wiring.
 *
 * `alertHandler` in security-audit-alerting.ts is a module-local variable, so a
 * registration in the web app's Next.js instrumentation does NOT cover this
 * process — yet notifyChainPreflightFailure (siem-delivery-worker),
 * notifyChainAppendVerificationFailure and notifyAnchorPublishFailure
 * (audit-chainer-worker) all fire from here. Without a registration in this
 * composition root every one of them hits `if (!alertHandler) return` and a
 * detected chain tamper reaches nobody.
 *
 * The handler's behaviour (payload, level, fingerprint, tags) is tested once in
 * packages/lib/src/audit/__tests__/chain-alert-payload.test.ts, which is the
 * single implementation all three processes share. What can only be checked
 * here is that this process actually registers it — and server.ts executes
 * start() at import time so it cannot be imported in a unit test, hence source
 * pins, matching server-clickhouse-wiring.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const source = readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

describe('processor server — chain alert composition-root wiring', () => {
  it('registers a chain alert handler at startup', () => {
    expect(source).toContain('setChainAlertHandler(');
    expect(source).toContain('buildChainAlertHandler(');
  });

  it('tags its alerts as coming from the processor process', () => {
    expect(source).toMatch(/buildChainAlertHandler\([\s\S]*?'processor'\s*\)/);
  });

  it('captures through @sentry/node, not the Next.js SDK', () => {
    expect(source).toContain("from '@sentry/node'");
    expect(source).toMatch(/Sentry\.captureException\(error, context\)/);
  });

  it('registers before the server starts listening', () => {
    const registerIndex = source.indexOf('setChainAlertHandler(');
    const listenIndex = source.indexOf('app.listen');
    expect(registerIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeLessThan(listenIndex);
  });
});
