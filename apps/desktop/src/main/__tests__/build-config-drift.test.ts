import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VARIANTS, resolveAppIdentity, type AppVariant } from '../../shared/app-identity';

/**
 * The app identity exists twice by necessity: once in TypeScript, where the
 * running shell reads it, and once in the electron-builder configs, which
 * decide what the installer is called and which scheme the OS registers.
 * Nothing at build time reconciles them — a coder build with PageSpace's appId
 * would install over PageSpace and inherit its userData, and the mistake would
 * only surface on a user's machine.
 *
 * These assertions are that reconciliation. Read as JSON rather than imported,
 * so the configs stay plain electron-builder input with no toolchain of their
 * own.
 */
const ROOT = join(__dirname, '..', '..', '..');

const CONFIG_FILES: Record<AppVariant, string> = {
  pagespace: 'electron-builder.pagespace.json',
  coder: 'electron-builder.coder.json',
};

function readConfig(file: string): Record<string, any> {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
}

const configs = Object.fromEntries(
  APP_VARIANTS.map((variant) => [variant, readConfig(CONFIG_FILES[variant])]),
) as Record<AppVariant, Record<string, any>>;

describe.each(APP_VARIANTS)('the %s packaging config', (variant) => {
  const config = configs[variant];
  const identity = resolveAppIdentity(variant);

  it('shares the base config rather than restating it', () => {
    expect(config.extends).toBe('./electron-builder.base.json');
  });

  it('packages under the identity appId and product name', () => {
    expect(config.appId).toBe(identity.appId);
    expect(config.productName).toBe(identity.productName);
  });

  it('registers exactly the identity protocol scheme', () => {
    expect(config.protocols).toHaveLength(1);
    expect(config.protocols[0].schemes).toEqual([identity.protocolScheme]);
  });

  it('ships the icons the running app also loads', () => {
    expect(config.mac.icon).toBe(`${identity.iconDir}/icon.icns`);
    expect(config.win.icon).toBe(`${identity.iconDir}/icon.ico`);
    expect(config.linux.icon).toBe(`${identity.iconDir}/icon.png`);
  });

  it('bundles a bundle it actually points at', () => {
    // `extraMetadata.main` overrides package.json's `main`; if it disagreed
    // with the `files` glob, the packaged app would have no entry point.
    const main: string = config.extraMetadata?.main ?? 'out/main/index.js';
    const outRoot = main.split('/')[0];
    expect(config.files).toContain(`${outRoot}/**/*`);
  });
});

describe('the two packaging configs', () => {
  const [pagespace, coder] = [configs.pagespace, configs.coder];

  // The identity is baked into the JS bundle, so sharing an out root or an
  // output dir means one app's installer can wrap the other app's code.
  it('never read from the same bundle directory', () => {
    const outRoots = APP_VARIANTS.map((variant) => {
      const main: string = configs[variant].extraMetadata?.main ?? 'out/main/index.js';
      return main.split('/')[0];
    });
    expect(new Set(outRoots).size).toBe(APP_VARIANTS.length);

    for (const [a, b] of [[pagespace, coder], [coder, pagespace]] as const) {
      const foreign = (b.extraMetadata?.main ?? 'out/main/index.js').split('/')[0];
      expect(a.files).not.toContain(`${foreign}/**/*`);
    }
  });

  it('never write to the same output directory', () => {
    expect(pagespace.directories.output).not.toBe(coder.directories.output);
  });

  it('leaves signing, notarization and publishing to PageSpace alone', () => {
    // Coder is a local build. Left on, electron-builder would sign it with
    // whatever certificate happens to be in the keychain and then fail
    // notarizing an app that has no release channel.
    expect(pagespace.mac.notarize).toBe(true);
    expect(pagespace.publish.provider).toBe('github');

    expect(coder.mac.notarize).toBe(false);
    expect(coder.mac.identity).toBeNull();
    expect(coder.publish).toBeNull();
  });

  it('shares the mac entitlements instead of duplicating them', () => {
    const base = readConfig('electron-builder.base.json');
    expect(base.mac.entitlements).toBe('build/entitlements.mac.plist');
    expect(base.mac.entitlementsInherit).toBe('build/entitlements.mac.inherit.plist');
    for (const config of [pagespace, coder]) {
      expect(config.mac.entitlements).toBeUndefined();
      expect(config.mac.entitlementsInherit).toBeUndefined();
    }
  });
});
