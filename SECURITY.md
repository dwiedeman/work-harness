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

The same applies to other privileged events, including run completion — with one distinction worth
stating precisely, because it is easy to read as more than it is.

`run_completed` — the event that declares a run finished, and so retires all seven of its completion
checks — is **reserved and receipted** (DER-2838). `append` refuses the type outright, and the fold
ignores any marker that does not carry a **completion receipt**: the record `complete-run` writes naming
the units it vouched for, the checks it evaluated, and the build it ran. On read, the fold re-derives the
ledger-checkable half of that claim — is this run tracking anything, is every tracked unit terminal, are
those exactly the units the receipt names — and ignores the marker when the ledger disagrees.

**That is integrity, not authentication.** `minted_by` is an unauthenticated string with exactly the
standing of `adjudicated_by`; there is no key, so any digest the harness could compute an appender could
compute too, which is why the receipt carries none. What it buys is bounded and real: a hand-written
marker **cannot** make an **active or empty** run read as completed, because the only way to satisfy the
cross-check is to make the units terminal — which is the work itself. What it does **not** buy: on a run
that would pass the gate anyway, a hand-written valid receipt still completes it, and the answer is then
the one the gate would have given. Ignored markers are listed in `state.run_completion_rejected` and
named by `complete-run`'s own output, so a rejected claim is visible rather than merely inert.

**This is a deliberate, recorded decision, not an oversight.** Adding authenticated privileged-event
ingress is real work and is not currently planned. Refusing relayed events instead would fork the ledger
between hosts, which trades a trust problem for a correctness problem. So the harness makes the waiver
*loud* rather than *impossible*: it appears on the `ready` line, on the board, and on every `watch` wake.

**What this means for you:** treat the ledger as a **record of what happened**, not as proof of **who
authorized it**. If authorization matters in your setting, review the waivers — they are surfaced
specifically so they can be reviewed.

### Review-gate evidence must agree with itself

A `review_findings` event carries both a `blockers` count and the `findings` list that count is about.
Until DER-2837 the count was **believed**: `ready` asked whether it was greater than zero, never whether
it was true, and the single consistency check in the codebase compared `recorded > actual` — catching an
over-count and letting an under-count through. So an event recording `blockers: 0` while carrying a live
priority-1 finding read as a **clean gate and authorized a merge**, with the blocker attached to the very
event that authorized it.

The count must now **exactly equal** the number of priority-≤1 entries in that same event's findings
list. It is derived from those findings at the producer, refused at `append`, and re-checked at every
read — the merge verdict, the board fold, and the waiver contract, which will not let an adjudication
cover findings the count denies. Both directions block, because a one-directional check is precisely the
shape that let the harmful direction through.

**This is not authentication, and it is not a fix for the section above.** It makes an event's *internal*
claims checkable against each other; it says nothing about **who** wrote the event. Anything that can
write the run directory can still write a *self-consistent* gate event recording zero blockers and zero
findings. What the check removes is the ability to record open findings and a clean verdict in the same
breath — a lie that is now visible rather than one that reads as evidence.

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

Closed, in the order they were addressed:

1. ~~Remove dynamic shell-argument construction from evidence queries.~~ Closed by DER-2836 — see
   *Evidence queries execute WITHOUT a shell* above.
2. ~~Make review-gate evidence internally consistent, so malformed evidence cannot authorize a merge.~~
   Closed by DER-2837 — see *Review-gate evidence must agree with itself* above.
3. ~~Reserve and receipt the run-completion event so a terminal state cannot be claimed by generic
   append.~~ Closed by DER-2838 — see the run-completion paragraphs under *Privileged event
   authority is documented, not authenticated* above for what the receipt does and does not prove.

4. ~~Preserve remote-read failure state so an unreadable host cannot read as a clean, empty pull.~~
   Closed by DER-2839 — the remote tail no longer ends in `2>/dev/null || true`, so a missing or
   unreadable host ledger is distinguishable from a healthy host with nothing new, and no longer
   deletes the held-fragment record.
5. ~~Require exact repository identity — not owner equality — before deriving cloud lifecycle
   events.~~ Closed by DER-2840 — `isCrossRepository === false` is now required alongside the owner
   check, because one owner may hold both a repository and a fork of it.

Roadmap items 1–5 are closed. That is a statement about those five findings only. It is **not** a claim
that the harness has no open weaknesses: authenticated privileged-event ingress is out of scope below,
the read-any-path exposure described under *Evidence queries execute WITHOUT a shell* remains the stated
residual risk, and unknown gaps are why *Reporting a vulnerability* exists.

Authenticated privileged-event ingress is **explicitly out of scope** for now; see the trust-boundary
section above for what that implies.

## Verifying a remote host's identity (`known_hosts`)

The harness dispatches leads to remote hosts over ssh (see `preflight`'s host checks, and the `.local`
HostName warning covered in the README). When ssh reports `REMOTE HOST IDENTIFICATION HAS CHANGED`, that
is a live warning about the identity of the box you are about to hand credentials to, not a formality to
clear.

**Do not run `ssh-keygen -R <host>` as a reflex, and never script it or wire it into the harness.**
Removing the `known_hosts` entry destroys the only local evidence that the key changed. Once it is gone,
ssh will connect to whatever key answers next — including an attacker's — and there is nothing left to
compare against.

The common case really is benign: a Tailscale (or any DHCP) IP gets reassigned, and the warning fires
against a `known_hosts` line recorded by whichever machine held that IP before. **But "usually stale" is
not "provably stale,"** and a real man-in-the-middle wants to hide inside exactly that assumption. Prove
it before acting on it.

### Prove staleness under two independent names, mechanically

A host that really is the box you think it is presents the **same key** under every name it answers to.
If the same host also has a `.local` mDNS name and a stable LAN IP already recorded in `known_hosts`,
those are **two attestations established independently** of the Tailscale-IP entry now in question. If
the presented key matches both, the Tailscale entry is stale. If it matches only one, or neither, stop —
that is not proof, and this is a case for the human operator, not for the harness to route around.

```bash
KEY_TYPE=ed25519            # the type named in the changed-host warning
HOST_IP=100.x.x.x           # the Tailscale IP that triggered the warning
HOST_MDNS=hostname.local    # independent attestation 1
HOST_LAN=192.168.x.x        # independent attestation 2

# Compare the presented key against BOTH independent names — mechanically, not visually.
diff <(ssh-keyscan -t "$KEY_TYPE" "$HOST_IP"   2>/dev/null | ssh-keygen -lf -) \
     <(ssh-keyscan -t "$KEY_TYPE" "$HOST_MDNS" 2>/dev/null | ssh-keygen -lf -) \
  && echo "MATCHES .local"

diff <(ssh-keyscan -t "$KEY_TYPE" "$HOST_IP"  2>/dev/null | ssh-keygen -lf -) \
     <(ssh-keyscan -t "$KEY_TYPE" "$HOST_LAN" 2>/dev/null | ssh-keygen -lf -) \
  && echo "MATCHES LAN IP"
```

**Compare fingerprints with `diff`, never by reading them.** In the incident that motivated this section,
the presented fingerprint and the stale one diverged only after the first character — `9W…` vs `9S…` —
with every other character identical. Read side by side at the end of a long run, that pair is the kind
of thing a tired human calls "the same" and waves through, which is precisely a MITM's fingerprint too.
`diff` on two `ssh-keygen -lf -` outputs doesn't skim: it reports exact equality (silent, exit 0) or it
doesn't, and only the exact-equality case is evidence.

### Only after both comparisons confirm the match, remove the stale entry

```bash
# Both diffs above matched: the presented key is attested independently by
# .local AND the LAN IP, so the Tailscale-IP entry is proven stale, not a MITM.
ssh-keygen -R "$HOST_IP"
ssh <host-alias>   # re-add known_hosts under the now-verified key
```

Name what was proven when you remove the entry — in the run ledger or a commit message, not only in your
head: which two independent names the presented key matched, and that the match was checked mechanically.
A removal with no stated proof is indistinguishable, later, from someone who just made the warning go
away.

## Verifying your own install

```bash
node --test e2e.test.mjs                    # hermetic fault-injection suite
node ~/.claude/skills/work/work-runner.mjs preflight   # deployed environment + credentials
```

`e2e.test.mjs` deliberately contains **defect pins** — assertions of currently-known-broken behavior. A
pin turning red means the underlying bug was fixed, not that your install is faulty. See the README.
