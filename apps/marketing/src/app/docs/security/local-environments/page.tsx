import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Local Environments — What You Are Agreeing To",
  description:
    "What a PageSpace local environment guarantees when an agent runs on your own computer, and exactly where those guarantees stop: signed single-use requests, owner-only control, confined file access, and no sandbox around commands.",
  path: "/docs/security/local-environments",
  keywords: [
    "local environment",
    "agent on my computer",
    "remote code execution",
    "sandbox",
    "prompt injection",
    "signed grants",
    "revocation",
    "zero trust",
  ],
});

// Derived from docs/security/local-environment-bridge.md in the PageSpace repository.
// This page may not claim anything that document does not; when they differ, that
// document is right and this page is wrong.
const content = `
# Local Environments — What You Are Agreeing To

A local environment lets a PageSpace agent read and write files and run commands **on your own
computer, under your own user account**. This page says what that guarantees and exactly where
the guarantees stop. It is written for the person deciding whether to enrol a machine, and it
does not soften anything: a command that runs on your computer runs as you.

Local environments are off unless the deployment has enabled them, and enabling them is a
deliberate operator choice.

## The right way to think about it

Enrolling a computer is like installing an SSH key on it. The questions that matter are the
ones you would ask about a key: who can connect with it, what it may do, how quickly you can
revoke it, and what the log shows. A prompt before each command is helpful. It is not a
security boundary, and this page does not treat it as one.

## What PageSpace guarantees

Each guarantee is followed by its exact limit.

- **Your computer connects out; nothing connects in.** The bridge daemon on your machine dials
  PageSpace and never listens on a port. *Limit: the daemon is a long-running process; if it is
  running, it is reachable through that outbound connection for as long as it stays connected.*

- **Your machine holds its own identity.** At enrolment the daemon generates a key on your
  computer, stores the private half in your operating system's credential store (or a file only
  your account can read), and sends
  PageSpace only the public half. The private key is never printed and never leaves the
  machine. *Limit: anyone with your user account on that computer can use that key, because it
  is that account's credential.*

- **Every request is signed, single-use, and bound to exactly what it asks for.** PageSpace
  signs each request for one operation and one set of arguments; it expires within a minute,
  cannot be replayed, and cannot be edited in flight. Your machine checks the signature before
  it does anything. *Limit: "bound to what it asks for" means the command line as sent. It does
  not describe what that program then does.*

- **PageSpace can only ask what you enabled.** When you create the environment you choose
  whether PageSpace may read files, write files, and run commands. PageSpace refuses to sign a
  request for anything you did not enable, so your machine never sees it. Only you, the person
  who enrolled the machine, can change that choice. *Limit: this is a list of operation kinds,
  not of programs. "Run commands" means any command.*

- **Your policy file has the final say.** The daemon reads a policy file that only you own and
  PageSpace never sees. No file, an unreadable file, or a file someone else could edit means
  every request is refused. A request PageSpace considers allowed is still refused if your file
  does not allow it. *Limit: the policy gates what may be asked for. It does not confine a
  command once it is running.*

- **Only you can drive your machine.** Only the person who enrolled it can start a session on
  it, approve a command, or change what it may do. Drive admins can delete the environment and
  revoke the machine; they can never bind to it. This is built into the data model, not a
  setting. *Limit: this controls who may ask. It does not control what your own agent read
  before it asked — see prompt injection below.*

- **Running a command always needs your click.** A command is never run silently the first time.
  The daemon freezes the exact command, working directory, environment and limits; a card in
  the chat shows you precisely that; your machine compares your click against what it froze
  before anything runs. A click can never run something other than what you saw. *Limit: you
  are judging a command line, and approving it is remembered — see the next section.*

- **File access is confined to the folders you declared.** Every file an agent reads or writes,
  and every working directory, must resolve inside a folder in your policy file; symlinks are
  resolved and \`..\` is refused. *Limit: this confines the paths an agent can name. It does not
  confine what a program does once it has started.*

- **Results are signed by your machine.** PageSpace verifies every result under the key it
  pinned at enrolment; a result that does not verify is never delivered to the agent.

- **Revocation is immediate, both ways.** Revoking the environment in PageSpace stamps it
  revoked, kills its connection tokens, and sends a signed revoke that makes the daemon delete
  its key and stop. Ctrl-C or \`pagespace env disconnect\` stops it locally and kills anything it
  started. *Limit: a "pause" that keeps the environment but stops its grants is not shipped
  yet; today the choices are revoke, or stop the daemon.*

- **Every decision is logged on your machine.** One line per request, allowed or refused, keyed
  by the request id, in \`~/.pagespace/env-audit.jsonl\`. *Limit: if that write fails, the
  daemon reports it once to its own terminal and keeps running; and PageSpace does not yet
  keep its own record of each request it signed, only of each one it refused.*

## Where the guarantees stop

These are not small print. They are the reason to read this page.

**There is no sandbox around a command.** A command you approve runs with your privileges,
exactly as if you had typed it into a terminal yourself. It can read any file you can read,
change any file you can change, reach anything on your network that you can reach, and use any
credential sitting in your home directory. Declared folders do not contain it. Operating-system
confinement (seatbelt on macOS, Landlock on Linux) is planned and is not in this release.

**Approving a command is remembered per program, not per command line.** Your approval is
keyed on you, this environment, the operation, and the program that ran — for a shell command
line, every program it names — for the time you choose: once, until the daemon stops, 30 days
(the default), or until you revoke it. Approving \`git status\` lets \`git push\` run from a new
chat tomorrow with no prompt, and does not let \`rm\` run. Approving a shell or an interpreter as
a program approves everything that shell or interpreter can do. A command line whose programs
cannot be pinned down (\`$(…)\`, \`eval\`, a nested \`sh -c\`, \`find -exec\`, \`sudo\`) is never
remembered and asks every time. Approvals live on your machine; PageSpace can revoke one, from
the environment's settings, and can never add one.

**Content other people wrote can steer your agent onto your machine.** On a shared drive, every
page, comment and message is written by other people, and your agent reads them. Text aimed at
the agent rather than at you — on a shared page, in a README, in a dependency's source — can
lead your agent to ask for a command on your computer. Owner-only control does not close this:
it fixes who may ask, not what your own agent read before asking. The click is the control. Its
limit is the previous paragraph: if the steered command runs only programs you have already
approved, it runs with no prompt, with whatever arguments the steered agent chose. This is
inherent to agents reading content nobody vetted; it is not a defect in the daemon, and it is
the strongest reason to approve programs, not shells, and to keep approvals short.

**There is no network control on your machine.** PageSpace's cloud sandbox runs inside an
isolated virtual machine. Your computer does not. A command on it can reach anything you can
reach, with whatever credentials are on the machine. Nothing in this release bounds that except
your click and what you keep on that computer.

**The server-side record is not complete yet.** PageSpace logs and audits every request it
refuses to sign. It does not yet write an audit row for each request it did sign and its
result, and there is no live view of what is running on your machine or a Stop button. Those
are in progress; until they ship, the log on your machine is the record.

## How this compares, honestly

File work confined to declared folders is comparable to a folder grant in tools like Cowork,
without that tool's isolation. Running commands without a sandbox and without a person at the
keyboard is materially less safe than Codex, and roughly Claude Code with its sandbox off, minus
the person watching the terminal. And this bridge is exposed on one path none of those tools
have: a prompt injection on a shared page becoming a command on a teammate's computer, with an
open network and that teammate's credentials in their home directory. The controls above are
what stand in for the sandbox until one exists. They are real. They are not a sandbox.

## What to do about it

- Run the daemon as an ordinary user, never as root, and prefer a machine — or a separate
  account — that does not hold secrets you would not hand to whoever is driving the agent.
- Leave "Run commands" off unless you need it. File work runs without it.
- Keep your policy's \`principals\` to yourself, and keep \`ops\` and \`roots\` narrow.
- Approve programs, not shells or interpreters, and pick the shortest scope that does the job.
- Stop the daemon when you are not using it, revoke approvals you no longer need, and read
  \`~/.pagespace/env-audit.jsonl\` when you want to know what actually ran.
- If anything looks wrong, revoke the environment: the machine's key is deleted and the daemon
  stops.

## Read next

- [The \`@pagespace/cli\` README](https://www.npmjs.com/package/@pagespace/cli) — the \`pagespace env\` section covers enrolment, the daemon, and the policy file in full.
- [Zero-Trust Architecture](/docs/security/zero-trust) — the token and audit model this bridge builds on.
- [Permissions](/docs/security/permissions) — how drive roles resolve.
`;

export default function LocalEnvironmentsSecurityPage() {
  return <DocsMarkdown content={content} />;
}
