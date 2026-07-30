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

### Evidence queries execute through a shell

The pre-run planning tool (`prep-for-work`) validates operator-supplied evidence queries against a
read-only command policy before running them. The validator is defense-in-depth against *mistakes* and
plausible-looking bad queries. **It is not a sandbox and must not be treated as one:** query text is
ultimately executed by a shell with your credentials, and shell metaprogramming can construct arguments
the validator did not evaluate.

There is a known unfixed weakness of exactly this kind. It is tracked and being fixed; the details are
withheld here rather than published as a working recipe against an unpatched release.

**What this means for you:** only run evidence queries you wrote or read. Do not feed the planner query
text that arrived from an untrusted source, and do not rely on the validator as the thing standing
between a hostile plan and your filesystem.

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
