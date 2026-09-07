# OpenAI Plugin / App Packaging Investigation (D2.10C)

Status: **research and planning only — no submission, no app built, no API
keys created.** This documents the CURRENT (verified live, September 2026)
OpenAI Apps SDK / ChatGPT app-directory submission model as it applies to
OCD, and proposes ONE narrow initial workflow. It does not commit to
building anything yet.

## The one initial workflow (deliberately narrow)

**"Inspect and preflight an autonomous payment."** Not the entire OCD
surface — just this:

- **Input:** a proposed payment (amount, asset, recipient/merchant,
  network) + an optional caller-supplied policy.
- **Output:** `ALLOW` / `REQUIRE_APPROVAL` / `BLOCK` + the reasons behind
  the decision + a signed, independently verifiable OCD receipt.

This maps directly onto the existing `preflight_payment` MCP tool
(confirmed present in `src/server.ts`'s current tool list) — no new
backend logic would be required, only packaging. Everything else OCD does
(screening tools, diligence, investigation/findings, merchant evidence,
webhooks, operation history) is explicitly OUT of scope for this first
integration.

## Can the existing MCP server be submitted directly, or does it need a wrapper?

**Verified: a standards-compliant MCP server over Streamable HTTP is the
supported foundation — no separate "plugin" rewrite is needed.** OpenAI's
own Apps SDK docs describe deploying "at stable HTTPS endpoints using the
streamable HTTP transport" as the baseline, and each tool just needs "a
name, description, input schema, and optional output schema" — which
`preflight_payment` already has.

What's optional on top, not required: an MCP server "can also return an
optional UI resource for clients that support MCP Apps" (richer
in-conversation UI). OCD's `preflight_payment` result is naturally
text/JSON (decision + reasons + receipt), so a UI resource is not needed
for this first workflow — it can be added later if a component-driven card
view is wanted.

**Needs verification:** whether ChatGPT's app-directory submission process
requires anything beyond the MCP server + listing metadata below — e.g. a
distinct manifest file, additional tool "annotation" metadata not visible
in the two sources reviewed, or a separate registration step from adding
the MCP URL as a connector. The two OpenAI developer-docs pages fetched
did not fully spell out the submission-time mechanics (only the
requirements list and the MCP/App relationship); flagging this as
**unresolved** rather than guessing.

## Current submission requirements (verified)

Required to submit for review:
- App/plugin name and a "clear, accurate, and straightforward" description
- Company or individual identity verification through the OpenAI Platform
  Dashboard (a verified OpenAI platform account)
- A clear, published **privacy policy** stating, at minimum: categories of
  personal data collected, purposes of use, categories of recipients, and
  data retention timelines
- A **support contact** end users can reach for help
- MCP/tool information: for every tool, a name (unique within the MCP
  server), a description that "explains its purpose explicitly and
  matches actual behavior," and annotations —
  - `readOnlyHint` for retrieval-only tools
  - `destructiveHint` for write/delete operations
  - `openWorldHint` for tools that touch external systems
- Test prompts and expected responses, for reviewers to exercise the app
- Localization information
- Screenshots — **optional, only if the app has a UI component**

**Needs verification:** exact logo/icon dimensions and formats — not
specified in either source reviewed. Also needs verification: precise
review turnaround time (only a general "apps passing review will begin
rolling out to users starting early 2026" rollout note was found, not a
per-submission SLA).

## Authentication expectations

OCD's `preflight_payment` tool is **keyless and pay-per-call (x402/MCP
payment)** — there is no username/password account layer today. This
creates a direct tension with OpenAI's stated requirement:

> Authenticated apps under review must provide login and password for a
> "fully featured demo account" with sample data. Apps requiring extra
> steps (new account sign-up, 2FA through an inaccessible account) will be
> **rejected.**

Because OCD's preflight tool doesn't require a login at all (payment is
the access mechanism, not identity), this requirement likely does not
apply in its strict form — but **needs verification directly with OpenAI**
whether a pay-per-call MCP tool with no account system is treated as
"unauthenticated" (fine, no demo account needed) or whether reviewers will
still expect some form of frictionless test access (e.g., a small prepaid
test balance or a fee-waived reviewer path). If OpenAI's review flow
cannot pay per call itself, we may need a reviewer-specific bypass or a
free-tier preflight call for review purposes — not yet decided, not yet
built.

Security best-practice guidance found (for later, if OCD ever adds
account-based auth to this surface): standardized OAuth 2.0/2.1
authorization-code flow via MCP's own auth metadata, scopes enforced
server-side, no secrets embedded in any UI component. Not applicable to
the narrow preflight-only workflow as scoped today.

## Privacy-policy requirements

OpenAI requires the categories of personal data collected, purposes,
recipients, and retention timelines to be published. **Needs
verification:** whether OCD's current public privacy policy (if one
exists at onchaindiligence.com) already covers this for the specific data
`preflight_payment` handles (proposed payment details, caller policy,
recovery credentials for authenticated operations). This doc does not
audit or draft that policy — flagging only that it must exist and be
accurate before submission, and that it should NOT overclaim (e.g. must
not imply OCD verifies merchant delivery or custodies funds, consistent
with OCD's existing claim-discipline rules).

## Logo / icon / listing asset requirements

**Needs verification.** Neither of the two OpenAI developer-docs sources
fetched specified exact icon dimensions, formats, or additional listing
assets beyond the optional UI screenshots. Treat as an open item to
confirm directly against OpenAI's current submission form before
building any assets.

## Tool/action schema expectations

Directly reusable from the existing MCP server: `preflight_payment`
already has a name, description, and input schema (per the D2.6 policy
evaluation contract) and returns a structured decision + receipt, which
satisfies the "optional output schema" guidance. Work needed before
submission, if this proceeds:
- Add explicit MCP tool annotations (`readOnlyHint: true` for
  `preflight_payment`, since it evaluates and returns a decision without
  mutating anything external — needs confirming this is accurate; if
  preflight creates a durable operation/lifecycle record server-side, it
  may not be strictly read-only and the annotation should reflect that
  honestly rather than being marked read-only for convenience).
- Confirm the description text matches actual behavior exactly (no
  aspirational language — consistent with OCD's existing "never fabricate
  capabilities" rule).

## Review requirements / quality & safety standards

- Apps must "behave predictably and reliably."
- Prohibited categories confirmed: adult content, gambling, illegal drugs,
  weapons, malware, tobacco/nicotine, execution of money transfers/crypto
  transfers/investment trades, subscriptions/digital products, and served
  advertisements. Commerce is restricted to "physical goods" only for
  monetization within the app itself.
- **This directly constrains the scope decision already made above**: OCD
  must package this as a *preflight/evaluation* tool (a decision + a
  receipt), never as a tool that itself executes a money transfer — which
  matches D2.10's architecture anyway (OCD evaluates; a separate wallet/
  PayBox executes). The prohibition on "execution of money transfers" is a
  strong argument for keeping this integration exactly as narrow as
  scoped, not broadening it to touch execution.

## Do ChatGPT and Codex share the same distribution package?

**Not confirmed — needs verification.** Neither WebSearch query surfaced a
direct statement on whether an OpenAI Apps SDK / MCP app submission is
shared automatically across ChatGPT and Codex surfaces, or whether Codex
has its own separate connector/registration flow. OCD's MCP server is
already documented (per `onchaindiligence-mcp`'s README) as usable as a
custom connector in ChatGPT via the same MCP URL used elsewhere — that is
a *connector* registration (works today, no directory submission needed),
which is different from the app-directory *listing* process described
above. This doc treats them as two separate things:
1. **Custom connector** (already works, no submission needed — a user or
   org manually adds `https://mcp.onchaindiligence.com/mcp` as a
   connector in ChatGPT's developer/MCP settings).
2. **App directory listing** (the reviewed, discoverable path described
   in this doc — requires the submission process above).
Whether Codex specifically inherits either path was not confirmed and
should be checked directly before assuming so.

## What files/assets would be needed to prepare (before submitting, not yet created)

- App name, short + medium description copy (can likely reuse/adapt
  `docs/AGENTNDX_LISTING.md`'s copy, narrowed to the single preflight
  workflow rather than all of OCD's capabilities)
- Logo/icon asset(s) — format/size TBD pending verification above
- Published privacy policy URL (verify existing one covers this surface,
  or draft an addition)
- Support contact
- Test prompts + expected responses for reviewers (e.g., a sample
  proposed payment that should return `ALLOW`, one that should return
  `BLOCK`, with the expected receipt shape)
- Tool annotation metadata added to `preflight_payment`'s MCP tool
  definition in `src/server.ts` (a small code change, not made in this
  task)
- Confirmation of the OpenAI Platform Dashboard identity-verification step
  (an account-level action, not a code change)

## Explicitly not done in this task

- No app or manifest built.
- No API keys created.
- No submission made.
- No changes to `src/server.ts` or any other source file.

## Sources

- [App submission guidelines — OpenAI developer docs](https://developers.openai.com/apps-sdk/app-submission-guidelines)
- [Submitting apps to the ChatGPT app directory — OpenAI Help Center](https://help.openai.com/en/articles/20001040)
- [Developers can now submit apps to ChatGPT — OpenAI](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/)
- [Developer Apps Terms — OpenAI](https://openai.com/policies/developer-apps-terms/)
- [Introducing apps in ChatGPT — OpenAI](https://openai.com/index/introducing-apps-in-chatgpt/)
- [Developer mode and MCP apps in ChatGPT — OpenAI Help Center](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [Build an MCP server — OpenAI developer docs](https://developers.openai.com/plugins/build/mcp-server)
- [MCP server concepts — OpenAI Apps SDK docs](https://developers.openai.com/apps-sdk/concepts/mcp-server)
- [Guide to authentication for the OpenAI Apps SDK — Stytch](https://stytch.com/blog/guide-to-authentication-for-the-openai-apps-sdk/)
- [Security & privacy — OpenAI Apps SDK guides](https://developers.openai.com/apps-sdk/guides/security-privacy)
