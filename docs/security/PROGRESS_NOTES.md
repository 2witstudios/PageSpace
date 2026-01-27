# Progress Notes - CodeQL Hardening

## Eric Elliott Zero-Trust Security Reflections

### Reflection 1: Initial Assessment (Pre-Fix)

**73 open CodeQL alerts** across the PageSpace monorepo. The alerts cluster into these categories:

1. **Path Injection (16 alerts)**: `content-store.ts` and `upload.ts` - Content hash validation exists but CodeQL needs explicit path containment verification after `path.join()`. Eric Elliott principle: "Defense in depth - validate at every boundary, not just the entry point."

2. **User-Controlled Bypass (12 alerts)**: Multiple files where request body values gate security decisions. Elliott principle: "Never trust client-supplied values - verify every claim server-side."

3. **Log Injection (8 alerts)**: User-controlled strings passed directly to console.log/console.warn. Elliott principle: "Sanitize all outputs, including logs - attackers use log injection for SIEM evasion."

4. **Remote Property Injection (6 alerts)**: User-controlled strings used as property keys. Elliott principle: "Never use dynamic property access with untrusted keys - whitelist valid keys."

5. **Missing Rate Limiting (4 alerts)**: Processor API endpoints missing rate limits. Elliott principle: "Assume attackers will automate - rate limit everything."

6. **SSRF/Request Forgery (4 alerts)**: `auth-fetch.ts` passes user URLs to fetch(). Elliott principle: "Validate all outbound request URLs against known-good patterns."

7. **ReDoS (2 alerts)**: Email regex and mention regex vulnerable to catastrophic backtracking. Elliott principle: "Never use unbounded repetition in regex matching user input."

8. **XSS (2 alerts)**: `offline.html` and `web-preview.tsx`. Elliott principle: "Encode all outputs - assume any data contains executable content."

9. **Other (19 alerts)**: Regex injection, format strings, prototype pollution, incomplete sanitization, TOCTOU races, insecure temp files, etc.

The existing codebase already has good security foundations (e.g., `resolvePathWithin`, `normalizeContentHash`, `sanitizeExtension`). The fixes will strengthen these existing patterns rather than introducing new security libraries.
