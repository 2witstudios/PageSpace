import { describe, it } from 'vitest';
import { assert } from './riteway';
import { CORE_TOOL_NAMES } from '../stub-tools';

describe('CORE_TOOL_NAMES', () => {
  it('contains exactly the 8 designated core tools', () => {
    assert({
      given: 'the CORE_TOOL_NAMES set',
      should: 'list exactly the 8 core tools',
      actual: [...CORE_TOOL_NAMES].sort(),
      expected: [
        'create_page',
        'get_page_details',
        'list_drives',
        'list_pages',
        'multi_drive_search',
        'read_page',
        'regex_search',
        'replace_lines',
      ],
    });
  });
});
