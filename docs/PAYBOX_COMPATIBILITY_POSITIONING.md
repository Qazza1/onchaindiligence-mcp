# PayBox Cross-Assistant Compatibility Positioning (D2.10D)

Status: **messaging document only — no code changes, no executor
broadening, no partnership claim made or implied anywhere in this repo.**
Written after the D2.6 `PayBoxCommerceExecutor` build (frozen; under final
independent review as of this task) to state, factually, what OCD's
relationship to PayBox actually is — and, just as importantly, what it is
not.

## The one-sentence position

**OCD is compatible with PayBox as an execution provider, independent of
whichever assistant interface is using PayBox.**

That's it. Not a partnership. Not an endorsement from PayBox. Not
exclusivity. A factual compatibility statement about how the two systems
compose.

## Why this framing and not a stronger one

`PayBoxCommerceExecutor` (D2.6) is OCD-side integration code that lets
OCD's preflight/policy layer sit in front of a payment PayBox executes.
Nothing about that requires PayBox's cooperation, endorsement, or
knowledge — it's built the same way any client integrates against a
public payment API. Claiming a "partnership" or "official integration"
would assert a business relationship that doesn't exist and isn't ours to
assert. The compatibility claim is the only one actually backed by the
code.

## Architecture (assistant-agnostic)

```
Agent proposes payment
        |
        v
OCD evaluates  ->  preflight / policy decision / evidence (signed)
        |
        v
PayBox authorizes and signs the payment
        |
        v
Payment executes
        |
        v
OCD independently observes settlement and reconciles
        |
        v
Signed receipt binding decision <-> actual settlement
```

Two independent parties, two independent responsibilities:
- **OCD decides and records evidence.** It never signs a payment
  authorization and never custodies funds.
- **PayBox authorizes and executes.** It never evaluates policy or
  produces OCD's evidence trail.

This separation is the whole point — OCD is deliberately not a wallet and
does not need to be trusted with execution to add value.

## Which assistants can this apply to?

Any assistant interface capable of driving an agent that (a) can call
OCD's MCP/x402/HTTP surfaces for preflight and evidence, and (b) can call
PayBox for execution. Concretely, this includes Claude, ChatGPT, and Grok
as *examples of assistant interfaces that could compose OCD with PayBox
this way* — not as assistants OCD has individually built, tested, or
certified integrations for. The D2.6 reference build validated the
mechanism end-to-end using one concrete path (OneSource via PayBox); it
did not validate every assistant surface that could theoretically drive
that same flow.

## What NOT to say (and why)

- **"MoonPay partnership"** — no such relationship exists; do not imply
  one because PayBox or an underlying rail may touch MoonPay
  infrastructure somewhere in its own stack.
- **"Official PayBox integration"** — "official" implies PayBox
  endorsement or a formal agreement. This is unilateral compatibility
  work on OCD's side, not a joint program.
- **"Jupiter supported by OCD"** — Jupiter is unrelated to the reference
  path actually built and reviewed (PayBox → OneSource, D2.6). Do not
  claim support for integrations that were never built.
- **"OCD has certified [Assistant X]"** — OCD validated the mechanism
  once, through one concrete reference flow. Naming an assistant as
  "certified" or "supported" implies per-assistant testing that has not
  happened.
- **Broadening to swaps** — `PayBoxCommerceExecutor` is scoped to the
  commerce/payment flow reviewed in D2.6. Do not describe or imply swap
  support; that would misstate what the frozen, reviewed executor
  actually does.

## Where this doc's language should be reused

Any future AgentNDX copy, OpenAI Plugin/App listing copy, or general
marketing material that mentions PayBox should draw its wording from this
doc's "one-sentence position" and architecture diagram, not restate or
loosen it. `docs/AGENTNDX_LISTING.md` already cross-references this file
under "What NOT to claim."
