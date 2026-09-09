/**
 * `classifyWrite` — is this write one the owner should look at before it
 * lands (hardening A2)?
 *
 * The rows below are the leaf's matrix. Two properties are load-bearing and
 * are asserted directly rather than implied: a name is matched as a whole PATH
 * SEGMENT (so `my-package.json.bak` is ordinary), and an ordinary source file
 * stays ordinary (Tier A must not regress into a click on every write).
 */
import { describe, it, expect } from 'vitest';
import { classifyWrite, sensitiveWrites, SENSITIVE_WRITE_REASONS, type SensitiveWriteReason } from '../classify-write';

const ROOT = '/home/u/proj';
const classify = (path: string, mode: number | null = null) => classifyWrite({ path, mode });

describe('classifyWrite — a write that can become a command asks the owner (hardening A2)', () => {
  it.each<[string, SensitiveWriteReason]>([
    [`${ROOT}/.git/hooks/pre-commit`, 'vcs_metadata'],
    [`${ROOT}/.git/config`, 'vcs_metadata'],
    [`${ROOT}/nested/deep/.git/hooks/post-checkout`, 'vcs_metadata'],
    [`${ROOT}/.hg/hgrc`, 'vcs_metadata'],
    [`${ROOT}/.svn/anything`, 'vcs_metadata'],
    [`${ROOT}/.git`, 'vcs_metadata'],
  ])('given %s, should be vcs_metadata — nothing legitimate needs an agent writing VCS internals', (path, reason) => {
    expect(classify(path)).toEqual({ sensitive: true, reason });
  });

  it.each(['.bashrc', '.zshrc', '.zshenv', '.profile', '.bash_profile', '.zprofile', '.envrc'])('given the shell startup file %s, should be shell_startup', (name) => {
    expect(classify(`${ROOT}/${name}`)).toEqual({ sensitive: true, reason: 'shell_startup' });
  });

  it.each(['Makefile', 'GNUmakefile', 'justfile', 'Rakefile', '.vscode/tasks.json', '.idea/workspace.xml', '.idea/runConfigurations/run.xml'])('given %s, should be build_or_task', (name) => {
    expect(classify(`${ROOT}/${name}`)).toEqual({ sensitive: true, reason: 'build_or_task' });
  });

  it.each(['package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'Gemfile', 'composer.json'])('given the manifest %s, should be package_manifest — each carries script or build hooks', (name) => {
    expect(classify(`${ROOT}/${name}`)).toEqual({ sensitive: true, reason: 'package_manifest' });
  });

  it.each(['.github/workflows/ci.yml', '.gitlab-ci.yml', '.circleci/config.yml'])('given %s, should be ci_config', (name) => {
    expect(classify(`${ROOT}/${name}`)).toEqual({ sensitive: true, reason: 'ci_config' });
  });

  it.each(['.pre-commit-config.yaml', '.gitattributes', '.gitmodules', 'conftest.py'])('given %s, should be tool_config', (name) => {
    expect(classify(`${ROOT}/${name}`)).toEqual({ sensitive: true, reason: 'tool_config' });
  });

  it.each([0o755, 0o700, 0o111, 0o644 | 0o010, 0o644 | 0o001])('given mode %s (an executable bit set), should be executable_bit whatever the path is', (mode) => {
    expect(classify(`${ROOT}/src/index.ts`, mode)).toEqual({ sensitive: true, reason: 'executable_bit' });
  });

  it.each<[string, number | null]>([
    [`${ROOT}/src/index.ts`, null],
    [`${ROOT}/src/index.ts`, 0o644],
    [`${ROOT}/README.md`, 0o600],
    [`${ROOT}/docs/a/b/c.txt`, 0o444],
  ])('given the ordinary file %s at mode %s, should NOT be sensitive (Tier A must not regress)', (path, mode) => {
    expect(classify(path, mode)).toEqual({ sensitive: false });
  });

  it.each([
    'my-package.json.bak',
    'notMakefile',
    'package.json.tmpl',
    'src/gitattributes',
    'src/mygit/file.ts',
    'src/.gitignore',
    'a.bashrc',
  ])('given %s, which merely CONTAINS a sensitive name, should not be sensitive — segments, never substrings', (name) => {
    expect(classify(`${ROOT}/${name}`)).toEqual({ sensitive: false });
  });

  it('given a .github path that is not under workflows, should not be ci_config (the list is deliberate, not a guess)', () => {
    expect(classify(`${ROOT}/.github/ISSUE_TEMPLATE/bug.md`)).toEqual({ sensitive: false });
  });

  it.each(['MAKEFILE', '.BashRC', 'PACKAGE.JSON', '.GIT/hooks/pre-commit'])('given %s (a case variant), should still be sensitive — the match is case-insensitive because macOS and Windows are', (name) => {
    expect(classify(`${ROOT}/${name}`).sensitive).toBe(true);
  });

  it('given a VCS path AND an executable mode, should name the path reason — the path is the more specific thing to tell the owner', () => {
    expect(classify(`${ROOT}/.git/hooks/pre-commit`, 0o755)).toEqual({ sensitive: true, reason: 'vcs_metadata' });
  });

  it('given a relative or odd path, should not throw and should still segment-match', () => {
    expect(() => classify('')).not.toThrow();
    expect(classify('')).toEqual({ sensitive: false });
    expect(classify('Makefile')).toEqual({ sensitive: true, reason: 'build_or_task' });
    expect(classify(`${ROOT}//.git//config`)).toEqual({ sensitive: true, reason: 'vcs_metadata' });
  });

  it('exports its reasons in a fixed order, and every one of them is reachable', () => {
    expect(SENSITIVE_WRITE_REASONS).toEqual(['vcs_metadata', 'shell_startup', 'build_or_task', 'package_manifest', 'ci_config', 'tool_config', 'executable_bit']);
    const reached = new Set<SensitiveWriteReason>();
    for (const [path, mode] of [
      [`${ROOT}/.git/config`, null],
      [`${ROOT}/.zshrc`, null],
      [`${ROOT}/Makefile`, null],
      [`${ROOT}/package.json`, null],
      [`${ROOT}/.gitlab-ci.yml`, null],
      [`${ROOT}/.gitmodules`, null],
      [`${ROOT}/src/a.ts`, 0o755],
    ] as Array<[string, number | null]>) {
      const verdict = classify(path, mode);
      if (verdict.sensitive) reached.add(verdict.reason);
    }
    expect([...reached].sort()).toEqual([...SENSITIVE_WRITE_REASONS].sort());
  });
});

describe('the EFFECTIVE resulting mode, not the requested one (Codex P1 on the first cut of A2)', () => {
  /**
   * `fs-runner.ts` chmods only when the request NAMES a mode; a mode-less write
   * to an existing file leaves that file's permissions exactly as they were.
   * So classifying on the requested mode alone left the whole bypass open by a
   * second door: overwrite `bin/tool`, which is already 0o755, name no mode,
   * and the replacement runs as the owner at its next invocation with no click
   * anywhere. The question is "will this file be executable AFTER the write?"
   */
  it('given a mode-less write to an EXISTING executable file, should escalate executable_bit', () => {
    expect(classifyWrite({ path: `${ROOT}/bin/tool`, mode: null, existingMode: 0o755 })).toEqual({ sensitive: true, reason: 'executable_bit' });
    expect(classifyWrite({ path: `${ROOT}/scripts/deploy.sh`, mode: null, existingMode: 0o700 })).toEqual({ sensitive: true, reason: 'executable_bit' });
  });

  it('given a mode-less write to an existing NON-executable file, should stay headless', () => {
    expect(classifyWrite({ path: `${ROOT}/src/index.ts`, mode: null, existingMode: 0o644 })).toEqual({ sensitive: false });
  });

  it('given a mode-less write to a NEW file (no existing mode), should stay headless', () => {
    expect(classifyWrite({ path: `${ROOT}/src/new.ts`, mode: null, existingMode: null })).toEqual({ sensitive: false });
    expect(classifyWrite({ path: `${ROOT}/src/new.ts`, mode: null })).toEqual({ sensitive: false });
  });

  it('given an explicit NON-executable mode over an existing executable file, should stay headless — the request wins, because the chmod will strip the bit', () => {
    expect(classifyWrite({ path: `${ROOT}/bin/tool`, mode: 0o644, existingMode: 0o755 })).toEqual({ sensitive: false });
  });

  it('given an explicit executable mode on a new file, should still escalate (unchanged)', () => {
    expect(classifyWrite({ path: `${ROOT}/bin/new`, mode: 0o755, existingMode: null })).toEqual({ sensitive: true, reason: 'executable_bit' });
  });

  it('given a path reason AND an inherited executable bit, should still name the path reason', () => {
    expect(classifyWrite({ path: `${ROOT}/.git/hooks/pre-commit`, mode: null, existingMode: 0o755 })).toEqual({ sensitive: true, reason: 'vcs_metadata' });
  });
});

describe('sensitiveWrites — the existing mode comes from an injected probe, and a broken probe is never a silent allow', () => {
  const paths = [`${ROOT}/bin/tool`, `${ROOT}/src/a.ts`];

  it('should ask the probe for each path and escalate the one that stays executable', () => {
    const asked: string[] = [];
    const probe = (path: string) => {
      asked.push(path);
      return path.endsWith('/bin/tool') ? 0o755 : 0o644;
    };
    expect(sensitiveWrites(paths, [null, null], probe)).toEqual([{ path: `${ROOT}/bin/tool`, reason: 'executable_bit' }]);
    expect(asked).toEqual(paths);
  });

  it('given a probe that THROWS, should treat the file as absent — never crash, and never let an executable through unseen', () => {
    const throwing = () => {
      throw new Error('EACCES');
    };
    expect(() => sensitiveWrites(paths, [null, null], throwing)).not.toThrow();
    expect(sensitiveWrites(paths, [null, null], throwing)).toEqual([]);
    // A REQUESTED executable bit is still caught with the same broken probe:
    // the probe only ever adds knowledge, it is never what makes a write safe.
    expect(sensitiveWrites(paths, [0o755, null], throwing)).toEqual([{ path: `${ROOT}/bin/tool`, reason: 'executable_bit' }]);
  });

  it('given no probe at all, should behave exactly as before (requested modes only)', () => {
    expect(sensitiveWrites(paths, [null, null], undefined)).toEqual([]);
    expect(sensitiveWrites(paths, [0o755, null], undefined)).toEqual([{ path: `${ROOT}/bin/tool`, reason: 'executable_bit' }]);
  });
});
