# Security

## What this software is

`work-harness` orchestrates long-running coding-agent sessions: it spawns agents, tracks their work in an
append-only ledger, gates merges on review evidence, and tears sessions down. It runs **with the
operator's own credentials** — their git identity, their `gh` token, their model accounts, their shell.

That is the correct mental model for every statement below. The harness is a **control plane for work you
have authorized**, not a sandbox that contains an adversary.

## Supported use

**Supervised sessions, in repositories you trust, driven by plans you wrote or reviewed.**

In that setting the harness is designed to be hard to *fool by accident*: gates refuse rather than
guess, terminal states are fail-closed, damaged ledgers are held rather than silently consumed, and
`preflight` refuses to start on a broken environment.

## Not supported

**Unattended operation against semi-trusted input.** Specifically, do not point this harness at:

- issue text, plan text, or PR content authored by someone you would not give a shell to;
- a repository whose contributors you do not trust;
- any workflow where no operator reviews what the agents did.

If you need that, this is not yet the right tool. Say so in your own runbook rather than assuming a
control below will hold.

## The trust boundary is the filesystem

**Anything that can write to the run directory can write any ledger event.**

The ledger is an append-only JSONL file. The harness validates the *shape* of what it reads and can
refuse malformed or inconsistent events — but it cannot prove **who** wrote one. There is no signing, no
per-actor credential, and no privileged ingress channel separate from ordinary file writes.

Two consequences worth stating plainly, because the harness's own prose asserts authority that the code
documents rather than enforces:

### Privileged event authority is documented, not authenticated

`gate_adjudication` — the event that waives a blocking review finding — is **validated** on write: it
must name its issue, cover every open blocker, reference findings that exist on the gate event, and name
an adjudicator. Those checks are real and they run at both write and read time.

But `adjudicated_by` is an **unauthenticated string**. The rule that "only the orchestrator or the human
operator may record a `gate_adjudication`" is a documented convention enforced by review and by the fact
that every waiver is printed loudly — not by authentication. An agent with filesystem access can name an
operator.

The same applies to other privileged events, including run completion.

**This is a deliberate, recorded decision, not an oversight.** Adding authenticated privileged-event
ingress is real work and is not currently planned. Refusing relayed events instead would fork the ledger
between hosts, which trades a trust problem for a correctness problem. So the harness makes the waiver
*loud* rather than *impossible*: it appears on the `ready` line, on the board, and on every `watch` wake.

**What this means for you:** treat the ledger as a **record of what happened**, not as proof of **who
authorized it**. If authorization matters in your setting, review the waivers — they are surfaced
specifically so they can be reviewed.

### Evidence queries execute WITHOUT a shell, and read whatever you can read

The pre-run planning tool (`prep-for-work`) validates operator-supplied evidence queries against a
read-only command policy, then executes them **in argv form — `spawnSync(cmd, args)`, one pipeline stage
at a time, with no shell**. Because nothing expands the query a second time, the arguments the policy
evaluated are the arguments the command receives.

That was not true before DER-2836. Queries reached `spawnSync(…, { shell: true })`, so the shell re-expanded
the text *after* validation and could hand a command arguments no rule had seen — `find . $(printf --
-delete)` passed the policy and deleted files. The same hole was reachable without any substitution at
all, via `$'…'`, a bare `$VAR`, or an unquoted glob matching a file whose name begins with a dash. It was
fixed by removing the expander rather than by enumerating expansions, because an enumeration is only ever
as complete as its author. Queries carrying an expansion or an unquoted glob are now refused outright:
nothing would expand them, and running the literal text would silently answer a different question.

**This still is not a general sandbox.** The policy's subject is *what a command does*, not *what it may
reach*. Every allowlisted command is one that reads and prints, and outbound channels are closed
(no `curl`/`ssh`, no `git ls-remote`/`fetch`, no gawk `/inet/…`, no `< /dev/tcp/…`) — but a read-only
command still reads **any file your account can read**, including outside the repo. A hostile query
cannot write, execute, or dial out; it can still name a path it has no business naming.

**What this means for you:** prefer evidence queries you wrote or read. If query text arrived from an
untrusted source, the policy will now stop it from writing or exfiltrating — but review it before
treating its *result* as evidence, and treat the ability to read arbitrary paths as the remaining risk.

## Reporting a vulnerability

Open a **private** report via GitHub Security Advisories on this repository
(`Security` → `Report a vulnerability`). Please do not open a public issue for anything exploitable.

Include: what you did, what happened, what you expected, and the commit SHA. A validator-only probe (one
that demonstrates the policy accepts something it should not, **without** executing a destructive payload)
is the most useful form and is how the current findings were confirmed.

There is no bounty. This is a personal tool published because it is useful, not a funded product.

## Hardening roadmap

Current known gaps, in the order they are being addressed:

1. Remove dynamic shell-argument construction from evidence queries.
2. Make review-gate evidence internally consistent, so malformed evidence cannot authorize a merge.
3. Reserve and receipt the run-completion event so a terminal state cannot be claimed by generic append.
4. Preserve remote-read failure state so an unreadable host cannot read as a clean, empty pull.
5. Require exact repository identity — not owner equality — before deriving cloud lifecycle events.

Authenticated privileged-event ingress is **explicitly out of scope** for now; see the trust-boundary
section above for what that implies.

## Verifying your own install

```bash
node --test e2e.test.mjs                    # hermetic fault-injection suite
node ~/.claude/skills/work/work-runner.mjs preflight   # deployed environment + credentials
```

`e2e.test.mjs` deliberately contains **defect pins** — assertions of currently-known-broken behavior. A
pin turning red means the underlying bug was fixed, not that your install is faulty. See the README.
