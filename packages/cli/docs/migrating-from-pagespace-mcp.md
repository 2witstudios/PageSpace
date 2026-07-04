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
@pagespace/cli pagespace`), run `pagespace login` in a terminal to store a real OAuth credential,
then:

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"]
    }
  }
}
```

No `env` block needed — `pagespace mcp` reads your stored login the same way every other
`pagespace` command does.

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

New:

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"]
    }
  }
}
```

## Explicit-token variant (agents, CI, headless boxes)

`pagespace login` needs a browser and isn't appropriate for CI or a service account. Mint a scoped
token instead:

```bash
pagespace tokens create --name "CI bot" --drive <driveId>
```

This prints the token once. Wire it into the MCP config exactly like the old `PAGESPACE_AUTH_TOKEN`,
just under the new variable name:

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"],
      "env": {
        "PAGESPACE_TOKEN": "<TOKEN_FROM_TOKENS_CREATE>"
      }
    }
  }
}
```

`--host <url>` (or the still-supported `PAGESPACE_API_URL` env var) overrides the default
`https://pagespace.ai` host for self-hosted instances, same as before.

## Zero-config bridge, if you're not ready to edit config yet

If you can't touch your MCP config right now, `@pagespace/cli` ships a `pagespace-mcp` bin alias
that behaves exactly like `pagespace mcp` and honors your existing `PAGESPACE_API_URL` /
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

It still prints the deprecation notice to stderr on every start. Migrate to `pagespace login` (or
`pagespace tokens create` for CI) and the plain `["mcp"]` args form when you get a chance — the
alias is a bridge, not a destination.

## What changed, mechanically

- `PAGESPACE_TOKEN` replaces `PAGESPACE_AUTH_TOKEN` as the primary env var. The old name still
  works — it's honored with a stderr deprecation notice, same precedence slot — but the new name
  is preferred going forward.
- `PAGESPACE_API_URL` is unchanged.
- Auth precedence is now: `--token` flag > `PAGESPACE_TOKEN` env (or legacy `PAGESPACE_AUTH_TOKEN`)
  > a stored `pagespace login` credential. The old package only ever supported the env var.
- The tool surface itself has full parity with `pagespace-mcp` v5.2.7 (the tool's final,
  deprecated release) — see `src/mcp/__tests__/fixtures/README.md` in this package for the
  mechanical parity gate and the documented v5.2.2→v5.2.7 delta.
