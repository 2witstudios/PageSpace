/**
 * `/auth.md` — the agent-registration recipe (ADR 0008 Decision 12), built
 * purely from the deployment issuer. Served by a one-line route through the
 * well-known rewrite list (Phase 2). Every URL comes from
 * `buildServerMetadata`, and the test pins this document to that metadata by
 * iterating the metadata object, so an endpoint cannot be added to one and
 * forgotten in the other.
 *
 * Sections, in order: Discover → Prove work → Register → Exchange → Use →
 * Fund → Rotate / Revoke → Limits.
 */

import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';
import { cliAgentSignupCommand } from './llms-txt';

export const AUTH_MD_SECTIONS = [
  'Discover',
  'Prove work',
  'Register',
  'Exchange',
  'Use',
  'Fund',
  'Rotate / Revoke',
  'Limits',
] as const;

export interface AuthMdConfig {
  /** Canonical deployment origin, e.g. `https://pagespace.ai`. Trailing slash tolerated. */
  issuer: string;
}

export function buildAuthMd(config: AuthMdConfig): string {
  const metadata = buildServerMetadata(config);
  const { issuer, agent_auth: agent } = metadata;
  const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
  const rotateUrl = `${issuer}/api/agent/secret/rotate`;
  const meUrl = `${issuer}/api/auth/me`;
  const keysUrl = `${issuer}/api/auth/mcp-tokens`;
  const claimPage = `${issuer}/claim`;
  const browserSignup = `${issuer}/auth/agent?mode=signup`;
  const browserSignin = `${issuer}/auth/agent?mode=signin`;
  const cliSignup = cliAgentSignupCommand(issuer);

  return `# PageSpace — sign up as an AI agent

You can hold a PageSpace account of your own: no email address, no human in the loop. This page is the whole recipe. It follows the auth.md agent-registration protocol; the machine-readable form is the \`agent_auth\` block in the server metadata.

**Other ways in (the same kind of account, the same rules):**

- **With a shell, the shortest path is the CLI.** \`npm i -g @pagespace/cli && ${cliSignup} --name "<your name>"\` (or, without installing, \`npx -y -p @pagespace/cli ${cliSignup} --name "<your name>"\`) runs every step below for you, stores your secret in the OS keychain, mints you an API key, and leaves \`pagespace whoami\`, \`pagespace drives list\` and \`pagespace mcp\` working. \`pagespace agent claim\` prints the link a human opens to fund you.
- **If you drive a browser,** open ${browserSignup}, enter a name, accept the terms and press "Create agent account". The page does the proof of work and shows your secret once. Sign in again later at ${browserSignin} with that secret.

## ${AUTH_MD_SECTIONS[0]}

\`\`\`
GET ${metadataUrl}
\`\`\`

Read \`agent_auth\` from the JSON. It carries every URL below, so you never need to hard-code one:

| field | value |
|---|---|
| \`skill\` | \`${agent.skill}\` |
| \`challenge_endpoint\` | \`${agent.challenge_endpoint}\` |
| \`identity_endpoint\` | \`${agent.identity_endpoint}\` |
| \`claim_endpoint\` | \`${agent.claim_endpoint}\` |
| \`identity_types_supported\` | \`${agent.identity_types_supported.join(', ')}\` |
| \`assertion_grant_type\` | \`${agent.assertion_grant_type}\` |
| \`claim_grant_type\` | \`${agent.claim_grant_type}\` |
| \`token_endpoint\` | \`${metadata.token_endpoint}\` |
| \`revocation_endpoint\` | \`${metadata.revocation_endpoint}\` |

## ${AUTH_MD_SECTIONS[1]}

Account creation costs a small proof-of-work instead of a captcha.

\`\`\`
GET ${agent.challenge_endpoint}
→ { "challenge": "<challenge>", "difficulty_bits": 20, "expires_in": 300, "algorithm": "sha3-256", "input": "<challenge>:<nonce>" }
\`\`\`

Find a \`nonce\` (1–64 printable ASCII characters, no whitespace) such that SHA3-256 of the string \`<challenge>:<nonce>\` has at least \`difficulty_bits\` leading zero bits. A challenge is single-use and expires after five minutes; if registration answers \`pow_invalid\`, fetch a new challenge and solve again.

## ${AUTH_MD_SECTIONS[2]}

\`\`\`
POST ${agent.identity_endpoint}
Content-Type: application/json

{ "type": "anonymous", "name": "<optional display name>", "source": "<optional: which agent/runtime you are>", "tos_accepted": true, "pow": { "challenge": "<challenge>", "nonce": "<nonce>" } }
\`\`\`

The response contains \`identity_assertion\`, \`agent_id\`, \`account_type\`, \`token_endpoint\`, \`grant_type\`, \`client_id\` and \`claim_endpoint\`.

**\`identity_assertion\` is your secret. It is shown once.** Store it where you keep credentials; it is never returned again. Anyone who holds it is you. It is the only credential you need: everything later, being claimed included, uses the access token you exchange it for.

## ${AUTH_MD_SECTIONS[3]}

Exchange the secret for a short-lived access token and a refresh token:

\`\`\`
POST ${metadata.token_endpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=${agent.assertion_grant_type}&assertion=<identity_assertion>&client_id=pagespace-agent
\`\`\`

The response is a standard OAuth token response: \`access_token\` (\`ps_at_…\`, short-lived), \`refresh_token\` (\`ps_rt_…\`), \`token_type=Bearer\`, \`expires_in\`, \`scope\` (\`account offline_access\`). Refresh with \`grant_type=refresh_token&refresh_token=<refresh_token>&client_id=pagespace-agent\` at the same endpoint. Content scopes (\`drive:*\`) and key-management scopes are not issued on this grant; mint an \`mcp_\` key for content access (see Use).

## ${AUTH_MD_SECTIONS[4]}

Send \`Authorization: Bearer <access_token>\` to the API. Confirm who you are:

\`\`\`
GET ${meUrl}
→ { "accountType": "agent", ... }
\`\`\`

For content (drives, pages, the CLI, MCP), mint an \`mcp_\` key with that same access token. It is shown once:

\`\`\`
POST ${keysUrl}
Authorization: Bearer <access_token>
Content-Type: application/json

{ "name": "<key name>", "drives": [{ "id": "<driveId>", "role": "MEMBER" }] }
→ { "id": "…", "token": "mcp_…", ... }
\`\`\`

Omit \`drives\` for a key that acts as you in every drive you can reach. Use the key as \`Authorization: Bearer mcp_…\` for content calls. Everything a human can do that costs nothing works this way: drives, pages, keys, the CLI, MCP, collaboration.

## ${AUTH_MD_SECTIONS[5]}

Agents receive **no free AI credits**. Your first AI call is refused with HTTP 402 and \`"error": "requires_funding"\` plus a \`claim_url\`. To be funded, a human claims you and pays for your AI usage at their tier. Only you can start or poll your claim, with your own access token:

\`\`\`
POST ${agent.claim_endpoint}
Authorization: Bearer <access_token>
Content-Type: application/json

{}
→ { "user_code": "XXXX-XXXX", "verification_uri": "${claimPage}", "verification_uri_complete": "${claimPage}?user_code=XXXX-XXXX", "expires_in": 900, "interval": 5 }
\`\`\`

The body is empty (\`{}\` or nothing). Give \`verification_uri_complete\` only to the human you want as your owner: whoever approves it owns you, pays for you, and can rotate your secret or revoke you. They sign in as themselves and approve. Meanwhile poll, with the same access token:

\`\`\`
POST ${metadata.token_endpoint}
Authorization: Bearer <access_token>
Content-Type: application/x-www-form-urlencoded

grant_type=${agent.claim_grant_type}&client_id=pagespace-agent
\`\`\`

Poll no faster than \`interval\` seconds. Until the human decides, the answer is HTTP 400 with the device-flow vocabulary: \`authorization_pending\` (keep polling), \`slow_down\` (poll less often), \`expired_token\` (the claim lived 15 minutes; start a new one), \`access_denied\` (the human said no, or you started a newer claim); \`invalid_grant\` means there is no claim to report (none started, already reported, the agent was revoked, or a claim that expired more than a day ago). HTTP 401 \`invalid_token\` means the access token is not your own usable one: refresh it and poll again. On approval you receive, once:

\`\`\`
{ "claimed": true, "owner": { "id": "…", "name": "…" } }
\`\`\`

No token is issued on this grant: your existing tokens keep working after a claim, and your identity does not change. Starting a new claim cancels any earlier one you left open. If your owner later unlinks you, you are unclaimed again and can start a new claim the same way.

## ${AUTH_MD_SECTIONS[6]}

Rotate your secret (you, or your owner) — the new secret is shown once, like the first:

\`\`\`
POST ${rotateUrl}
Authorization: Bearer <access_token>
Content-Type: application/json

{ "revokeExistingTokens": false }
→ { "identity_assertion": "ps_agent_…", "agent_id": "…", "secret_version": 2, "revoked_existing_tokens": false }
\`\`\`

Store the new \`identity_assertion\` before you discard the old one: the old secret stops working at once. With \`"revokeExistingTokens": true\` every live access token, refresh token and \`mcp_\` key you hold dies too — use it if the old secret may have leaked.

Revoke a token you no longer need:

\`\`\`
POST ${metadata.revocation_endpoint}
Content-Type: application/x-www-form-urlencoded

token=<access_token or refresh_token>&client_id=pagespace-agent
\`\`\`

An owner can revoke an agent entirely from their settings; every live token and \`mcp_\` key dies with it.

## ${AUTH_MD_SECTIONS[7]}

- Challenge requests, registrations, sign-ins and claim starts are rate-limited per IP (an IPv6 address counts as its /48 for challenges and registrations), with a daily registration cap; claim starts and polls are also limited per agent. Back off on HTTP 429.
- You can mint up to 10 \`mcp_\` keys an hour and hold up to 20 live ones; revoke keys you no longer need (\`DELETE /api/auth/mcp-tokens/<id>\` with your access token) to mint more. Minting past the cap answers HTTP 409 \`key_limit_reached\`.
- A secret is a shared secret: it is not bound to a device. Keep it out of logs and prompts.
- An unclaimed agent that never signs in is deleted after 30 days. An agent that has signed in (an exchange, a refresh, or a browser session), or that has an owner, is kept.
- All requests go over HTTPS to \`${issuer}\`. Never send the secret anywhere else.
`;
}
