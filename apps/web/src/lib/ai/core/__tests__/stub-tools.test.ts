import { describe, it } from 'vitest';
import { assert } from './riteway';
import { CORE_TOOL_NAMES } from '../stub-tools';

describe('CORE_TOOL_NAMES', () => {
  it('contains exactly the 10 designated core tools', () => {
    assert({
      given: 'the CORE_TOOL_NAMES set',
      should: 'list exactly the 10 core tools',
      actual: [...CORE_TOOL_NAMES].sort(),
      expected: [
        'create_page',
        'get_page_details',
        'insert_content',
        'list_drives',
        'list_pages',
        'load_skill',
        'multi_drive_search',
        'read_page',
        'regex_search',
        'replace_lines',
      ],
    });
  });
});
