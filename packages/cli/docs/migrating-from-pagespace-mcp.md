# Migrating from `pagespace-mcp` to `pagespace mcp`

The standalone `pagespace-mcp` npm package is deprecated in favor of `pagespace mcp` — the same
stdio MCP server, generated mechanically from the same operation registry the SDK and CLI use,
shipped as part of `@pagespace/cli`. The tool surface is unchanged; only how you install and
authenticate it is.

**Nothing breaks today.** `npx pagespace-mcp` keeps working exactly as before — same env vars,
same tools — it just prints a one-line deprecation notice to stderr (never stdout, so it never
corrupts the MCP protocol stream) pointing back at this guide. Move to `@pagespace/cli` on your
own schedule.

## Claude Desktop

Old config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "pagespace-mcp@latest"],
      "env": {
        "PAGESPACE_API_URL": "https://pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "<YOUR_PAGESPACE_MCP_TOKEN_HERE>"
      }
    }
  }
}
```

New config — install `@pagespace/cli` once (`npm install -g @pagespace/cli` or use `npx -y -p
@pagespace/cli pagespace`), then mint a drive-scoped key for the agent (`pagespace keys`, guided,
or `pagespace keys create --drive <id> --role member --save-as-profile agent`, flag-driven —
either way it opens a browser for a one-time consent screen and saves the result under a profile
name), and point the MCP config at that profile:

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"],
      "env": {
        "PAGESPACE_PROFILE": "agent"
      }
    }
  }
}
```

An `env` block naming a profile (or `PAGESPACE_TOKEN`) is required — `pagespace mcp` never falls
back to your personal `pagespace login` credential, and that credential grants no content access
anyway (it's scoped to key management only). See [Credentials](../README.md#credentials) and
[`agent-access.md`](agent-access.md) for why `pagespace login` isn't the right credential for an
MCP client regardless.

## Claude Code

Same config shape, in `.mcp.json` at your project root (or via `claude mcp add`):

Old:

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "pagespace-mcp@latest"],
      "env": {
        "PAGESPACE_API_URL": "https://pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "<YOUR_PAGESPACE_MCP_TOKEN_HERE>"
      }
    }
  }
}
```

New (the `env` block naming a credential is required here too):

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"],
      "env": {
        "PAGESPACE_PROFILE": "agent"
      }
    }
  }
}
```

## Explicit-token variant (agents, CI, headless boxes)

`pagespace login` needs a browser and isn't appropriate for CI or a service account.
`pagespace keys create` also opens a browser — minting a token is always a deliberate,
human-approved consent step, on this CLI as much as on the web. To get a copy-pasteable secret
for a headless box, mint on a machine with a browser: `pagespace keys create … --show-token`
prints the `mcp_` token exactly once, or mint from **Settings → MCP** in the app, where a human
is already in an authenticated browser tab:

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"],
      "env": {
        "PAGESPACE_TOKEN": "<TOKEN_FROM_SETTINGS_MCP>"
      }
    }
  }
}
```

`--host <url>` (or the still-supported `PAGESPACE_API_URL` env var) overrides the default
`https://pagespace.ai` host for self-hosted instances, same as before.

## Zero-config bridge, if you're not ready to edit config yet

If you can't touch your MCP config right now, `@pagespace/cli` ships a `pagespace-mcp` bin that
behaves exactly like `pagespace mcp` and honors your existing `PAGESPACE_API_URL` /
`PAGESPACE_AUTH_TOKEN` env vars unchanged — only the package you install changes:

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "-p", "@pagespace/cli", "pagespace-mcp"],
      "env": {
        "PAGESPACE_API_URL": "https://pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "<YOUR_PAGESPACE_MCP_TOKEN_HERE>"
      }
    }
  }
}
```

This `pagespace-mcp` bin is itself a first-class, supported entry point — not a deprecated shim —
so there's no pressure to move off it. Whenever it's convenient, a profile created via `pagespace
keys` (guided) or `pagespace keys create` (flag-driven) (for a person's own machine) or a Settings
→ MCP token (for CI) plus the plain `["mcp"]` args form is the same server with one fewer moving
part, but staying on `pagespace-mcp` via `npx` is a perfectly fine destination too.

## What changed, mechanically

- `PAGESPACE_TOKEN` replaces `PAGESPACE_AUTH_TOKEN` as the primary env var. The old name still
  works — it's honored with a stderr deprecation notice, same precedence slot — but the new name
  is preferred going forward.
- `PAGESPACE_API_URL` is unchanged.
- Auth precedence is now: `--token` flag > `PAGESPACE_TOKEN` env (or legacy `PAGESPACE_AUTH_TOKEN`)
  > a stored profile named via `--profile`/`PAGESPACE_PROFILE`. One of those must be given
  explicitly — `pagespace mcp` refuses to start on a bare `pagespace login` credential. The old
  package only ever supported the env var.
- The tool surface itself has full parity with `pagespace-mcp` v5.2.7 (the tool's final,
  deprecated release) — see `src/mcp/__tests__/fixtures/README.md` in this package for the
  mechanical parity gate and the documented v5.2.2→v5.2.7 delta.
