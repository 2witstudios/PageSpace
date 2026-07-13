import { describe, it, expect } from 'vitest';
import { deriveProjectFieldsFromRepo } from './NodeActionPalette';

describe('deriveProjectFieldsFromRepo', () => {
  it('given a full_name with an owner, should derive the short repo name', () => {
    const result = deriveProjectFieldsFromRepo({ full_name: 'org/my-repo', clone_url: 'https://github.com/org/my-repo.git' });
    expect(result.name).toBe('my-repo');
  });

  it('given a repo, should pass clone_url through unchanged as repoUrl', () => {
    const result = deriveProjectFieldsFromRepo({ full_name: 'org/my-repo', clone_url: 'https://github.com/org/my-repo.git' });
    expect(result.repoUrl).toBe('https://github.com/org/my-repo.git');
  });

  it('given a full_name with no owner segment, should use it as the name', () => {
    const result = deriveProjectFieldsFromRepo({ full_name: 'standalone-repo', clone_url: 'https://github.com/standalone-repo.git' });
    expect(result.name).toBe('standalone-repo');
  });
});
