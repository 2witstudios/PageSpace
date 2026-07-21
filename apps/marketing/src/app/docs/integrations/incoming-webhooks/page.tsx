import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Incoming Webhooks — Integration",
  description: "Mint a signed, page-scoped URL so an external system (CI, monitoring, a script) can push events into a PageSpace channel or trigger a workflow — HMAC signing, curl example, and how it composes with workflow triggers.",
  path: "/docs/integrations/incoming-webhooks",
  keywords: ["webhooks", "incoming webhooks", "HMAC", "signature", "CI", "monitoring", "workflow trigger", "curl"],
});

const content = `
# Incoming Webhooks

Incoming Webhooks let an external system — CI, a monitoring tool, a cron job, any script that can send an HTTP POST — push events into PageSpace, without handing it a full account credential. Mint a URL scoped to one page, and every delivery to it is signed and verified.

> **Not the same thing as the "Generic Webhook" AI tool.** PageSpace also has an *outbound* AI tool provider (used by agents to call out to an arbitrary URL as part of a tool call). Incoming Webhooks is the opposite direction: an external system calling *into* PageSpace. If you're looking for how an agent posts data out to a webhook, that's a different feature — this page is about receiving.

## What you can do

- Mint a named webhook on any non-trashed page — only the drive's **owner** or an **admin** can create, toggle, or delete one. The **Incoming Webhooks** dialog that does this from the UI is currently wired up on **Channel** and **AI Chat (agent)** pages; other page types can still mint one via the API.
- Get back a URL (\`/api/webhooks/<token>\`) and a secret shown exactly once — save it, PageSpace never shows it again and can't recover it for you.
- POST any JSON object to that URL, signed with the secret. A **Channel** webhook with no other wiring posts the payload's \`content\` into the channel verbatim, as if a bot had typed it.
- Bind one or more **workflows** to a webhook (via the API — see below) so the same delivery also kicks off an agent run, with the full payload handed to it as context.
- Disable a webhook without deleting it (its URL stops accepting deliveries but its history and bindings stay), or delete it outright.

## The POST contract

- **Body**: any JSON object, up to **64KB** raw. Larger bodies are rejected with \`413\` before PageSpace even attempts to parse them.
- **Headers**: \`x-pagespace-signature\` and \`x-pagespace-timestamp\` (see signing below). A missing or invalid signature, or a timestamp more than 5 minutes old, gets a generic \`403\`.
- **Unknown or disabled webhook**: a generic \`404\` — PageSpace never reveals whether a token used to exist.
- **Channel pages** additionally require \`{ "content": string, "username"?: string }\` — this is deliberately Discord's incoming-webhook shape. \`content\` is posted verbatim (up to 4000 characters); \`username\`, if set, overrides the webhook's configured name as the message's displayed sender (up to 80 characters).
- **Pages with no default action** (anything that isn't a Channel today) still accept any JSON object — there's just nothing to post it into unless a workflow trigger is bound.

## Signing a delivery

PageSpace's native scheme (\`v0\`) is HMAC-SHA256 over \`v0:{timestamp}:{rawBody}\`, sent as two headers:

- \`x-pagespace-timestamp\` — Unix seconds when you signed the request.
- \`x-pagespace-signature\` — \`v0=<hex-encoded HMAC-SHA256 of the message above, using your webhook's secret>\`.

The signature must be computed over the **exact bytes** you send as the body — sign first, then send that same string unmodified.

**Bash / openssl:**

\`\`\`bash
SECRET="the-secret-shown-when-you-created-the-webhook"
URL="https://your-pagespace-host/api/webhooks/<token>"
BODY='{"content":"Deploy finished ✅","username":"CI"}'

TIMESTAMP=$(date +%s)
SIGNATURE="v0=$(printf '%s' "v0:\${TIMESTAMP}:\${BODY}" \\
  | openssl dgst -sha256 -hmac "$SECRET" \\
  | sed 's/^.* //')"

curl -X POST "$URL" \\
  -H "Content-Type: application/json" \\
  -H "x-pagespace-timestamp: $TIMESTAMP" \\
  -H "x-pagespace-signature: $SIGNATURE" \\
  -d "$BODY"
\`\`\`

**Node.js:**

\`\`\`js
import { createHmac } from "crypto";

const secret = "the-secret-shown-when-you-created-the-webhook";
const url = "https://your-pagespace-host/api/webhooks/<token>";
const timestamp = Math.floor(Date.now() / 1000);
const body = JSON.stringify({ content: "Deploy finished ✅", username: "CI" });
const signature = "v0=" + createHmac("sha256", secret).update(\`v0:\${timestamp}:\${body}\`).digest("hex");

await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-pagespace-timestamp": String(timestamp),
    "x-pagespace-signature": signature,
  },
  body,
});
\`\`\`

A \`200\` means the default action ran (a Channel post, for example). A \`202 { accepted: true, action: "none" | "triggers" }\` means the delivery was accepted but had no channel action, bound workflows, or both — \`action\` tells you which. Retry a \`429\` (rate limited), a \`409\` (an identical delivery is still being processed — see below), or a \`5xx\`/\`503\` (transient) — those are the sole retryable outcomes. \`400\` (malformed payload), \`403\` (bad/missing signature), \`404\` (unknown or disabled token), and \`413\` (body too large) are permanent failures: fix the request before sending it again, since an unmodified retry can only fail the same way, and retrying it in a loop risks a retry storm against your own integration.

**Deliveries are idempotent per signed request.** Each signed request (its exact timestamp + signature pair) is normally processed at most once: re-sending the identical bytes — a network-timeout retry, for example — returns \`200 { ok: true, duplicate: true }\` without posting or firing anything again (the duplicate acknowledgment always has this \`200\` shape, even when the original delivery answered \`202\`). An identical request that arrives while the first is still being processed gets a \`409\` with a \`Retry-After\` — keep retrying it: you'll see the duplicate acknowledgment once the first attempt commits, or deliver fresh if it failed or its short in-flight claim lapsed (claims from a crashed attempt free up after about a minute, well inside the 5-minute signature window). A retry you **re-sign** with a fresh timestamp counts as a new delivery, so keep retrying with the original signed bytes when you want at-most-once behavior, and re-sign only when the previous attempt definitively failed with a retryable error. Two things to know at the edges: signatures have 1-second granularity, so two **distinct** events with byte-identical bodies signed in the same second are indistinguishable from a retry and collapse to one delivery — include a unique field (an event id or timestamp) in the payload if you emit identical bodies at sub-second rates; and dedup requires the store to be reachable — during a database outage deliveries fail retryably rather than dedup silently.

## Composability: one delivery, two actions

A single signed delivery can do **both** things at once — post the default action for the page type **and** fire every enabled workflow bound to that webhook. They're not alternatives; binding a workflow doesn't turn off the channel post, and the channel post doesn't block the workflow from also running.

Bindings are managed through the API (there's no dedicated UI for this yet). Managing webhooks (minting, and binding triggers) is deliberately a human console action — a *drive-scoped* \`mcp_...\` token is rejected outright, on purpose. Script it with an **all-drives** token instead: \`pagespace keys create --all-drives --name ci-webhooks --show-token --yes\` (see [MCP](/docs/integrations/mcp)), or mint one from **Settings > MCP**. That token carries your own owner/admin authority and authenticates as a \`Bearer\` token, which also sidesteps this write endpoint's CSRF check (CSRF only applies to cookie-based session auth):

\`\`\`bash
# Bind a workflow to a webhook — owner/admin only, workflow must be in the same drive as the page
curl -X POST "https://your-pagespace-host/api/pages/<pageId>/webhooks/<webhookId>/triggers" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer mcp_your_token_here" \\
  -d '{"workflowId":"<workflowId>"}'
\`\`\`

Once bound, the workflow receives the full JSON payload as context (wrapped so the agent sees it verbatim) prepended to its configured prompt, and runs under the workflow owner's billing and credit limits — the sender never waits on it, since it fires after the HTTP response goes out.

### Try it yourself (manual end-to-end check)

1. Create a Channel page and open its **Incoming Webhooks** dialog (the webhook icon in the page toolbar, titled "Incoming Webhooks") to mint a webhook. Save the URL and secret.
2. Create a workflow from the drive's **Workflows** dashboard (\`/dashboard/<driveId>/workflows\`) — it needs a name, a prompt, an AI Chat agent page to run against, and a cron schedule (the schedule still applies; binding a trigger just adds "also run on a webhook delivery" on top of it). Bind it to the webhook with the API call above.
3. Send one signed \`POST\` with \`{"content": "Deploy finished"}\` using either signing example above.
4. Confirm **both** things happened from that single request: the message \`Deploy finished\` appears verbatim in the channel, **and** a new run shows up for the bound workflow (its agent page picks up the delivery as context).

## Good to know

- **Least privilege by design.** A webhook secret only ever authenticates deliveries to the one page it was minted on — it can't read, list, or act on anything else in the drive, unlike a full API key or OAuth token.
- **No dedupe, no event-type filtering (yet).** Every enabled trigger on a webhook fires on every accepted delivery; if you need "only fire on this kind of event," filter in the payload you send or in the workflow's own prompt.
- **A page moved to a different drive after a trigger was bound** is re-checked at fire time — if the page's current drive no longer matches the workflow's drive, that trigger is skipped and recorded as a stale binding rather than silently executed.
- **The secret is shown once.** If you lose it, delete the webhook and mint a new one — PageSpace stores it encrypted and can't display it again.

## Related

- [Channels](/docs/page-types/channel) — the page type with a built-in default webhook action today.
- [AI Chat](/docs/page-types/ai-chat) — where bound workflows run and how agent prompts work.
- [AI in your Workspace](/docs/features/ai) — how workflows and agent runs fit into the bigger picture.
- [Zero-Trust](/docs/security/zero-trust) — the broader signing/verification model this shares with Google Calendar and Zoom.
`;

export default function IncomingWebhooksPage() {
  return <DocsMarkdown content={content} />;
}
