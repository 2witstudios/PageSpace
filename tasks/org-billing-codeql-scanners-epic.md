# Org billing scanner review fixes

Scope: CodeQL alerts 383 and 384 on PR #2906. Isolated from the master sync and org cutover lanes.

- Given a money field with dollar characters in its identifier, should preserve its exact name when resolving every alias use.
- Given an aliased money value, should resolve only standalone uses in its scope, preserving properties, object keys, and longer identifiers.
- Given a source directory, should scan regular TypeScript consumers using directory-entry metadata without a separate file-status check.
- Given a conversation drive authorization refusal, should verify the route's refusal without requiring a database in its unit test.
