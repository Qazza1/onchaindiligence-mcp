# Pilot Support Expectations

Realistic, founder-led support for a pilot customer — **not** an
enterprise SLA, and no contractual uptime promise is made anywhere in
this document.

## Primary support channel

Email: `support@onchaindiligence.com` (the same public address already
listed on onchaindiligence.com and used for the AgentNDX submission).
This is a founder-led operation — there is no dedicated support team, no
ticketing system, and no phone/on-call line today.

## Normal response target

**Within 1 UK business day** for a normal question during a pilot
(UK business hours, Mon–Fri). This is a target, not a guaranteed SLA —
stated honestly as best-effort, consistent with `docs/PILOT_TERMS.md`'s
"best-effort availability" during the pilot.

## What counts as payment-critical

A payment-critical issue is one where:
- A payment's outcome is genuinely ambiguous (the customer doesn't know
  whether it happened), or
- OCD's own preflight/finalize/observation endpoints are unreachable or
  erroring in a way that blocks the customer's payment flow.

A payment-critical report gets priority over a general question, but
still has no contractual response-time guarantee during a pilot.

## If execution state is ambiguous

**Do not retry the payment automatically.** Every OCD operation detail
response includes a `recovery` object (`needsAttention`,
`mayAlreadyHavePaid`, `safeNextAction`) specifically so an ambiguous
outcome is never silently treated as "didn't happen" and resubmitted.
If a payment's state is unclear:

1. Check `GET /me/operations/:operation_id` (or the app's Operation
   history view) for the current `recovery` guidance.
2. Resume/reconcile the **same** operation and execution binding —
   never open a new operation or re-execute the payment to "try again."
3. If still unclear after that, email support with the `operation_id`
   (never the recovery credential, API key, or any private key) and
   describe what's ambiguous.

## No automatic payment retry — recovery/reconciliation first

This mirrors the product's own design (D2.4's exactly-once execution
binding + D2.6's PayBox gateway discipline): OCD's own tooling never
resubmits a payment on your behalf, and support will never advise
resubmitting a payment whose outcome is unknown until reconciliation
(bounded on-chain transaction discovery, independent observation) has
had a chance to resolve it.

## How incidents are escalated

For a pilot, "escalation" means: the customer emails
`support@onchaindiligence.com` describing the issue and its impact
(payment-critical or not), and gets a direct reply from the person
running OCD — there is no multi-tier support queue to escalate through.
If something looks like a genuine bug (not an integration question),
it's treated as priority regardless of the response-time target above.

## What we do not promise

No contractual uptime percentage, no 24/7 coverage, no dedicated account
manager, no guaranteed resolution time. This is stated up front so a
pilot customer's expectations match reality, not because the product
isn't taken seriously.
