# First Pilot Package (post-D2.10)

Status: **pilot-readiness package — no code changes, no test resources
created.** The product is live (D2.6 closed, D2.7/D2.8A/D2.9A deployed,
D2.10A Bazaar indexed, D2.10B AgentNDX submitted). This document is what's
needed to find and run the FIRST real pilot customer without changing the
product. Technical integration steps live in `docs/PILOT_QUICKSTART.md`;
this document is everything around that — who to target, how to run the
pilot, what "success" means, and what to say to them.

Commercial/trust companion docs (all discussion drafts, not formal legal
documents): `docs/PILOT_TERMS.md` (pilot terms), `docs/PILOT_SUPPORT.md`
(support expectations), `docs/DATA_HANDLING.md` (what's actually stored
and for how long).

Positioning to hold everywhere below: **OnChainDiligence is the
independent evidence and reconciliation layer around autonomous agent
payments** — "know why your agent paid, and verify what happened
afterward." Developer framing: **keep your wallet, keep your payment
provider, add OCD once.**

## 1. Ideal first-pilot profile

**Team profile:** a small, technical team already making real (or
near-real, pre-launch-but-imminent) autonomous agent payments via x402 on
Base with USDC — an agent framework, an agentic-commerce startup, or a
service that both buys and/or sells via x402. They operate their own
wallet or execution provider today (PayBox is one example OCD already
proves out end-to-end; any x402-capable or direct on-chain path works).

**Technical characteristics:**
- Already integrating x402 (buyer side, seller side, or both) on Base
  mainnet, paying/receiving in USDC.
- Comfortable calling a REST API or wiring in an MCP server directly —
  this is a dev-led integration, not a procurement-led one.
- Has hit (or can clearly foresee) the "did this actually pay?" /
  "why did my agent do that?" ambiguity that comes from running
  autonomous payments in production without independent evidence.

**Buyer/user persona:** a founding engineer or engineering lead at an
early-stage agentic-payments team — the person who would actually wire in
the preflight call and read the investigation output, not a procurement
or compliance department at a large enterprise. AgentNDX and Bazaar are
plausible discovery channels for exactly this persona, given OCD's own
listings there.

**Why OCD matters to them:** they already have payment logs, but those
logs are self-reported by their own system — no independent, portable,
signed record of the decision or the settlement. As soon as they have any
real volume, "what did my agent actually decide, and did the payment
really settle" becomes a genuine support/debugging/audit problem. OCD
turns that into a receipt and a deterministic investigation instead of
grepping application logs.

**What would make them a poor pilot:**
- Not on Base / not using USDC — OCD's independent settlement
  observation is scoped to that today, stated honestly, not hidden.
- Wants OCD to custody funds, sign transactions, or replace their wallet
  or payment provider — that's not what this is.
- Wants a large enterprise procurement process, a custom SLA negotiation,
  or a compliance-vendor certification before touching the product.
- Wants guaranteed fraud detection, guaranteed compliance, or proof of
  merchant service delivery — none of which OCD claims.
- Not actually making (or imminently making) real autonomous payments —
  a purely hypothetical "we might do this someday" team won't produce
  real usage signal in a short pilot window.
- Wants custom chain/asset support built for them before the pilot even
  starts — that's D3 scope, not this pilot.

## 2. Recommended pilot workflow

```
Agent proposes payment
        │
        ▼
OCD preflight (POST /x402/lifecycle/preflight-payment)
   → ALLOW / REQUIRE_APPROVAL / BLOCK + signed PREFLIGHT receipt
        │
        ▼
Customer's OWN wallet/provider authorizes + executes
   (PayBox is one proven option — not required)
        │
        ▼
OCD independently observes settlement + finalizes
   → signed Commerce receipt, settlement CONFIRMED / NOT_CONFIRMED / UNVERIFIED
        │
        ▼
Investigation / findings / (optional) merchant-response evidence
   → reconciliation, support/compliance-ready record
```

PayBox is never a requirement — it's the one execution path already
proven end-to-end (D2.6's live reference), but the pilot should
deliberately prove OCD works around whatever the customer already has.
Full technical steps: `docs/PILOT_QUICKSTART.md`.

## 3. Pilot success / failure criteria

Practical, observable, no vanity metrics:

1. Customer integrates OCD (preflight → their own execution → finalize)
   **without replacing** their existing wallet or payment provider.
2. A meaningful number of the customer's **real** payment decisions
   (not synthetic test calls) pass through OCD preflight during the
   pilot window.
3. At least one receipt or investigation output is actually **used** —
   for debugging, a support ticket, or an internal compliance/reconciliation
   review — not merely generated and ignored.
4. At least one post-payment investigation/finding surfaces something
   (a mismatch, an ambiguous state, a conservative binding-strength
   disclosure) that the customer's own raw payment logs did not already
   make obvious.
5. The customer can explain, in their own words, why OCD's output is
   more useful to them than what they had before.
6. The customer wants to keep using OCD after the pilot — a concrete
   next step (continued real usage, expanded volume, willingness to be
   referenced), not a polite "sure, why not."
7. The pilot does not surface a case where OCD's actual claim boundary
   (see below) silently fails to hold for their use case — if it does,
   that gets disclosed honestly, not patched over mid-pilot.

Failure looks like: the customer never routes real payments through
preflight, treats OCD as a bolt-on they don't read, or needs something
OCD explicitly does not do (custody, guaranteed compliance, fraud
detection, non-Base support) to get value.

## 4. Onboarding checklist (customer-facing)

Full detail in `docs/PILOT_QUICKSTART.md`; summary in send-order:

1. **What OCD does (and doesn't)** — independent evidence/reconciliation
   layer; not a wallet, not a compliance guarantee, not a fraud detector.
2. **Integration prerequisites** — an existing execution path on Base
   mainnet USDC; a small USDC balance for OCD's own per-call fees.
3. **Account/API setup** — `POST /accounts` (free, one-time, key shown
   once).
4. **MCP vs HTTP/x402** — same underlying routes either way; pick
   whichever fits their stack.
5. **Payment preflight** — `POST /x402/lifecycle/preflight-payment`
   ($0.01), returns decision + signed receipt.
6. **Execution by their own provider** — durable execution binding, then
   their own signer/PayBox/other executes.
7. **Observation/receipt** — `POST /operations/:id/finalize`; OCD
   independently re-reads the chain, never trusts a claimed outcome.
8. **Operation history/investigation** — `GET /me/operations`,
   `GET /me/operations/:id/investigation` (+ `/export`).
9. **Findings** — deterministic, in the investigation response; no AI
   analyst, no fraud scoring.
10. **Caller-reported merchant response evidence** (optional) — always
    labeled `CALLER_REPORTED`, never independently verified by OCD.
11. **Webhook integration** (optional) — event-driven instead of
    polling; signed, verifiable, retried on failure.

## 5. Claim discipline (hold this in every customer conversation)

Never say: payment is "safe," OCD guarantees compliance, OCD proves
merchant delivery, OCD detects fraud, OCD authorizes spending, OCD holds
customer funds, or that there's a PayBox partnership.

Say instead: OCD preflight returned ALLOW / REQUIRE_APPROVAL / BLOCK;
receipt proof is VALID / INVALID / UNVERIFIABLE; OCD independently
observed supported on-chain settlement; this is caller-reported merchant
response evidence; these are deterministic findings/contradictions; the
binding strength is stated explicitly (including when it's conservative).

## 6. Customer outreach

### A. Founder-to-founder (short)

> Subject: independent evidence layer for autonomous agent payments
>
> Hi [name] — following what you're building with [their agent/payment
> system]. We're building OnChainDiligence: an independent layer that
> checks a proposed agent payment before it happens and independently
> verifies what actually settled afterward — you keep your own wallet and
> payment provider, we just sit alongside it.
>
> We're looking for one team already making autonomous payments to run a
> small pilot with their existing setup — no migration, no replacing
> anything. Worth a quick conversation?

### B. Technical outreach (slightly longer)

> Subject: preflight + independent settlement verification for [their
> agent] payments
>
> Hi [name] — we've built OnChainDiligence, an independent evidence and
> reconciliation layer for autonomous agent payments on Base/x402.
>
> The flow: your agent proposes a payment → OCD evaluates it against a
> policy you define and returns ALLOW / REQUIRE_APPROVAL / BLOCK with a
> signed receipt → your own wallet or provider (PayBox or anything else)
> authorizes and executes → OCD independently re-reads the chain and
> issues a settlement receipt, rather than trusting your executor's own
> success claim. Everything is signed and independently re-verifiable.
> We also surface deterministic findings (mismatches, unconfirmed
> settlement, contradictions) from evidence already on file — no AI
> scoring, no new data source.
>
> We're not asking you to replace your wallet or payment provider — OCD
> adds on top of what you already run. Looking for one team already doing
> autonomous/x402 payments to pilot this with their real flow. Happy to
> walk through the API (MCP or plain HTTP/x402) on a short call if useful.

### C. Follow-up (after expressed interest)

> Great to hear — let's find 20 minutes to walk through your current
> payment flow and see where OCD would actually plug in. No prep needed
> on your end; I'll bring the technical quickstart. Does [day/time] or
> [day/time] work?

## 7. 20-minute discovery call outline

Not a questionnaire — a conversation, in this order:

1. **Current payment flow** — how does the agent decide to pay, and what
   actually executes it today?
2. **Where the decision is made** — is there a policy check today, or is
   it implicit in code?
3. **Wallet/provider** — what executes the payment (own signer, PayBox,
   something else)? Confirms Base/USDC fit.
4. **Biggest pain today** — debugging, compliance, or reconciliation:
   what's the worst incident they've had where they couldn't tell what
   happened?
5. **What records they keep today** — application logs? Anything signed
   or portable, or all internal-only?
6. **Ambiguous payment state** — what happens today when settlement is
   unclear? Do they ever risk paying twice, or do they have their own
   safeguard already?
7. **Evidence needs afterward** — who needs to see proof after the fact
   (support, a customer, an auditor), and in what form?
8. **Does OCD actually fit** — walk through the workflow above against
   their real flow; end with a clear "let's do it" or "not yet, and here's
   why," not a vague maybe.

## 8. Pilot boundaries

The pilot is **not**:
- A custom consulting engagement.
- Custom chain/asset integration ahead of demand.
- A feature-wishlist implementation project.
- A replacement wallet or payment processor migration.

Do not commit to D3-scope work (new chains, new executors, bespoke
features) before seeing an actual, specific customer need emerge from
real pilot usage — and even then, that's a separate decision, not an
automatic pilot deliverable.

## 9. Pricing

Optimizing for an easy first sale and low procurement friction, not for
enterprise pricing architecture — using what the product actually is
today (pay-per-call x402 routes, no subscription mechanism exists).

**Recommended pilot price:** no separate platform/subscription fee. The
customer simply pays OCD's existing live per-call x402 prices as they use
it — $0.01–$0.05 per call depending on the route (see
`docs/BAZAAR_ACTIVATION.md`'s price table) — with nothing added on top.
This is deliberately the same mechanism a production customer would use;
a pilot customer paying per call IS the product working, not a discount
approximation of it. No invoice, no PO, no contract to countersign before
the first API call.

**Recommended post-pilot starting price/model:** the same usage-based
per-call pricing, continued indefinitely as the default — not a new
commercial construct. Do not introduce a flat "Pro" tier until a specific
customer asks for volume predictability.

**What's included:** the entire current product surface at the same
per-call prices — preflight, settlement observation/receipts,
investigation/findings, caller-reported merchant evidence, and webhooks.
Nothing is feature-gated behind a higher tier today.

**What's NOT included:** any dedicated uptime/SLA commitment beyond
`docs/PILOT_SUPPORT.md`'s best-effort terms, custom feature work, custom
chain/asset support, or white-glove integration engineering — those are
separate conversations, not part of the per-call price.

**How to answer a custom-volume request:** don't quote a flat number
without data. Offer to have a conversation about a simple flat monthly
allowance once there's real observed usage from the pilot to base it on
— never commit to a number in advance of evidence.

**When to revisit pricing:** once there are multiple real pilot customers
with actual usage data, or the moment a specific customer asks for volume
pricing — not on a fixed calendar schedule, and not before either of
those happens.

## 10. Genuinely missing before onboarding a real customer

Updated after closing the four gaps identified in the prior pilot-
readiness pass — remaining items are now genuinely small:

- **Pilot terms, support policy, and data handling are now documented**
  (`docs/PILOT_TERMS.md`, `docs/PILOT_SUPPORT.md`,
  `docs/DATA_HANDLING.md`) — all three explicitly labeled as discussion
  drafts / best-effort, not formal legal or SLA commitments.
- **No automatic data-retention or deletion mechanism exists** (see
  `docs/DATA_HANDLING.md`'s own flagged gap) — fine to disclose openly to
  a small technical pilot, would need addressing before a larger or more
  compliance-sensitive customer. Not treated as an engineering task here.
- **Webhook delivery scheduler.** Enqueueing and the delivery route are
  production-active; the external cron-job.org trigger still needs the
  operator's own account/job setup (tracked separately, see the master
  roadmap) before webhook delivery is fully hands-off. Fine for a pilot
  that mainly polls the API, worth flagging if the customer specifically
  wants webhooks on day one.
- **Base/USDC-only is a real scope narrowing**, not just a pitch caveat —
  confirm it fits the specific customer's stack on the discovery call,
  not after they've started integrating.
