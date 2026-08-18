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

const pkg = readConfig('package.json');

/** Where a config reads its main-process bundle from on disk. */
function sourceRoot(config: Record<string, any>): string {
  const entry = config.files.find(
    (f: unknown) => typeof f === 'object' && f !== null && 'from' in (f as object),
  );
  return entry ? entry.from : 'out';
}

/** Every on-disk directory a config reads from. */
function sourceRoots(config: Record<string, any>): string[] {
  return config.files.map((f: unknown) =>
    typeof f === 'string' ? f.split('/')[0] : (f as { from: string }).from,
  );
}

/** Where the bundle lands inside the asar. */
function packagedRoots(config: Record<string, any>): string[] {
  return config.files.flatMap((f: unknown) =>
    typeof f === 'string'
      ? (f.startsWith('out') ? [f.split('/')[0]] : [])
      : [(f as { to?: string; from: string }).to ?? (f as { from: string }).from],
  );
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

  it('packages a bundle where package.json says the entry point is', () => {
    // Both apps ship the same package.json, so both must land their bundle at
    // the `main` path it declares. The coder build gets there by remapping its
    // own source tree — deliberately NOT via electron-builder's
    // `extraMetadata`, which rewrites the source package.json in place and
    // would leave the repo pointing at out-coder.
    expect(config.extraMetadata).toBeUndefined();
    const entryRoot = pkg.main.split('/')[0];
    expect(packagedRoots(config)).toEqual([entryRoot]);
  });
});

describe('the two packaging configs', () => {
  const [pagespace, coder] = [configs.pagespace, configs.coder];

  // The identity is baked into the JS bundle, so reading from a shared tree
  // means one app's installer can wrap the other app's code. They land at the
  // same path inside the asar; what must differ is where they read from.
  it('never read from the same bundle directory', () => {
    const roots = APP_VARIANTS.map((variant) => sourceRoot(configs[variant]));
    expect(new Set(roots).size).toBe(APP_VARIANTS.length);

    for (const [a, b] of [[pagespace, coder], [coder, pagespace]] as const) {
      expect(sourceRoots(a)).not.toContain(sourceRoot(b));
    }
  });

  it('never write to the same output directory', () => {
    expect(pagespace.directories.output).not.toBe(coder.directories.output);
  });

  it('leaves notarization and publishing to PageSpace alone', () => {
    // Coder is a local build with no release channel; notarizing it would fail
    // and publishing it has nowhere to go.
    expect(pagespace.mac.notarize).toBe(true);
    expect(pagespace.publish.provider).toBe('github');

    expect(coder.mac.notarize).toBe(false);
    expect(coder.publish).toBeNull();
  });

  it('ad-hoc signs coder rather than reaching for a real certificate', () => {
    // `identity: null` would skip bundle signing outright, and an unsigned
    // bundle does not launch on Apple Silicon. Disabling discovery instead
    // gets an ad-hoc signature, without letting a certificate that happens to
    // be in the keychain sign a local build.
    expect(coder.mac.identity).toBeUndefined();
    for (const [name, script] of Object.entries<string>(pkg.scripts)) {
      if (!name.startsWith('package:coder')) continue;
      expect(script).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false');
    }
  });

  it('points every coder script at the coder config, and no other', () => {
    for (const [name, script] of Object.entries<string>(pkg.scripts)) {
      if (!name.startsWith('package')) continue;
      const expected = name.startsWith('package:coder')
        ? 'electron-builder.coder.json'
        : 'electron-builder.pagespace.json';
      expect(script).toContain(`--config ${expected}`);
    }
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
