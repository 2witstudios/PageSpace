import { describe, it, expect } from 'vitest';
import { scrubEnv, isHardDeniedEnvVar } from '../scrub-env';

describe('scrubEnv — the server never gets to set environment on the user\'s machine except through the allowlist', () => {
  it('given allowlisted variables, should keep exactly those', () => {
    expect(scrubEnv({ LANG: 'C', TERM: 'xterm', FOO: 'bar' }, ['LANG', 'TERM'])).toEqual({ LANG: 'C', TERM: 'xterm' });
  });

  it.each([
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'PYTHONPATH', 'PERL5OPT', 'RUBYOPT',
    // minor (review): further hooks — loader tunables, rc-file hijack, shell hooks, runtime option injection, git command injection
    'GLIBC_TUNABLES', 'GCONV_PATH', 'LOCPATH', 'HOME', 'ZDOTDIR', 'XDG_CONFIG_HOME', 'PROMPT_COMMAND', 'SHELLOPTS', 'CDPATH', 'NODE_PATH', 'PYTHONHOME', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF',
    'BASH_FUNC_ls%%', 'BASH_FUNC_anything',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_ASKPASS', 'SSH_ASKPASS', 'TMPDIR', 'PERL5DB',
    // CodeRabbit (PR #2528): the remaining Java launcher option hooks
    'JDK_JAVA_OPTIONS', 'JDK_JAVAC_OPTIONS',
  ])(
    'given %s, should drop it EVEN IF it is allowlisted (loader/interpreter hooks are hard-denied)',
    (name) => {
      expect(scrubEnv({ [name]: 'x', LANG: 'C' }, [name, 'LANG'])).toEqual({ LANG: 'C' });
      expect(isHardDeniedEnvVar(name)).toBe(true);
    },
  );

  it('given an empty allowlist, should return {}', () => {
    expect(scrubEnv({ LANG: 'C' }, [])).toEqual({});
  });

  it('given undefined, should return {}', () => {
    expect(scrubEnv(undefined, ['LANG'])).toEqual({});
  });

  it('given a variable name that is not a valid identifier, should drop it even if allowlisted', () => {
    expect(scrubEnv({ 'LANG=x': 'C', 'A B': 'y' }, ['LANG=x', 'A B'])).toEqual({});
  });

  it('given a value containing a NUL byte, should drop that variable', () => {
    expect(scrubEnv({ LANG: 'C\0evil' }, ['LANG'])).toEqual({});
  });

  it('given a non-string value, should drop that variable', () => {
    expect(scrubEnv({ LANG: 1 as unknown as string }, ['LANG'])).toEqual({});
  });

  it('should be case-sensitive on names but deny the DYLD_ prefix family as a whole', () => {
    expect(scrubEnv({ DYLD_ANYTHING: 'x', lang: 'c' }, ['DYLD_ANYTHING', 'lang'])).toEqual({ lang: 'c' });
  });

  it('should not mutate its input', () => {
    const input = { LANG: 'C', PATH: '/bin' };
    scrubEnv(input, ['LANG']);
    expect(input).toEqual({ LANG: 'C', PATH: '/bin' });
  });
});
