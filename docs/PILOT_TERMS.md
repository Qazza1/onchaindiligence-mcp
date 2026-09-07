# Pilot Terms — discussion draft, not legal advice

This is a plain-language discussion draft for an early-stage, founder-led
technical pilot of OnChainDiligence (OCD). **It is not legal advice and
does not replace a negotiated contract** — treat it as the starting point
for a conversation, not a document either side should sign as-is for
anything beyond a small, no-fee technical pilot.

## Purpose

The pilot exists to find out whether OCD's independent evidence and
reconciliation layer is genuinely useful around the customer's existing
autonomous agent payment flow — not to deliver a custom feature, not to
migrate the customer onto a new wallet or payment provider.

## Duration

A pilot is expected to run **2–4 weeks** of real (or near-real) usage,
extendable by mutual agreement. Either side may end it earlier — see
"Either party may stop" below.

## Your wallet and payment provider stay yours

The customer's existing wallet, signer, or payment provider (PayBox or
otherwise) remains entirely under the customer's own control throughout
the pilot. OCD does not take over, replace, or gain access to it.

## OCD does not custody or authorize funds

OCD never holds customer funds and never signs or authorizes a payment on
the customer's behalf. OCD evaluates a proposed payment (preflight) and
independently observes settlement afterward — the customer's own
wallet/provider is what actually executes every payment.

## The customer remains responsible for payment execution

Choosing to execute, retry, or not execute a payment is always the
customer's own decision and the customer's own system's action. OCD's
preflight decision (`ALLOW` / `REQUIRE_APPROVAL` / `BLOCK`) is an input
to that decision, not a substitute for it.

## What OCD provides

Policy-based payment preflight, independent settlement observation,
signed receipts, deterministic investigation/findings, and (optionally)
a channel to record caller-reported merchant response evidence. See
`docs/PILOT_QUICKSTART.md` for the technical detail.

## Availability during the pilot

OCD is provided **best-effort** during the pilot. There is no uptime
guarantee or contractual SLA — see `docs/PILOT_SUPPORT.md` for realistic
support expectations. This is a founder-led pilot, not a 24/7 enterprise
operation.

## Not a legal or compliance guarantee

OCD's checks (preflight, sanctions screening, findings) are evidence-based
tooling, not a legal or compliance guarantee. The customer remains
responsible for their own regulatory obligations; OCD does not warrant
that using it satisfies any specific law, regulation, or compliance
regime.

## Confidentiality

If either side shares non-public information during the pilot (roadmap
details, integration specifics, usage data), both sides agree to keep it
confidential and use it only to evaluate and run the pilot — a simple
mutual expectation, not a substitute for a formal NDA if one is needed for
a larger engagement.

## Feedback

The customer agrees OCD may ask for and use their feedback (what worked,
what didn't, feature requests) to improve the product. Anything the
customer explicitly marks as confidential, or that reveals customer-
specific business details, will not be shared publicly without
permission; anonymized or aggregated usage learnings may be used
internally.

## Either party may stop the pilot

Either side may end the pilot at any time, for any reason, with
reasonable notice (a short message is enough — no formal process
required).

## No obligation to continue after the pilot

Running a pilot creates no obligation for the customer to keep using OCD,
and no obligation for OCD to offer any specific terms afterward beyond
what's discussed in good faith at the time (see pricing below).

## Pricing during the pilot

See the pricing section in `docs/FIRST_PILOT_PACKAGE.md` for the current
recommended pilot pricing posture.

## What happens after the pilot

See the same section for the recommended post-pilot pricing/model — the
short version: no premature enterprise pricing architecture, a simple
usage-based or flat starting point, revisited once there's real signal.
