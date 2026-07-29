export const CORE_TOOL_NAMES = new Set([
  'list_drives',
  'list_pages',
  'read_page',
  'get_page_details',
  'create_page',
  'replace_lines',
  'insert_content',
  'regex_search',
  'multi_drive_search',
  // The capability loader: always upfront so the skill catalog's "call
  // load_skill" instruction is actionable in every exposure mode.
  'load_skill',
]);
