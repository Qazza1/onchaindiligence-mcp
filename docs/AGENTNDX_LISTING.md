# AgentNDX Listing Package (D2.10B)

Status: **prepared, not submitted.** Copy below is ready to paste into an
AgentNDX (or similar agent-directory) listing form once someone decides to
submit it — nothing here has been sent anywhere.

## Category

**Primary:** Payments

**Secondary (only if the form allows a second category, and only where it
genuinely fits):** Identity / Auth / Compliance — OCD's checks are
compliance/sanctions screening tools, not an identity/auth provider itself;
list this secondary only if the directory's taxonomy has no better fit.

## Name

OnChainDiligence

## Short description (≤160 chars)

> Keyless compliance and reconciliation for autonomous agent payments — preflight, signed receipts, and independent settlement verification.

(159 characters)

## Medium description (2–3 paragraphs)

OnChainDiligence is the independent evidence and reconciliation layer
around autonomous agent payments. Before an agent pays, OCD evaluates the
proposed payment against a caller-defined policy and existing sanctions/
compliance evidence, returning an ALLOW/REQUIRE_APPROVAL/BLOCK decision
with a portable, signed receipt explaining why. After the agent's own
wallet or payment provider executes the payment, OCD independently
observes on-chain settlement where supported and produces a verifiable
receipt binding the two — so "the agent decided to pay" and "the payment
actually settled" are never conflated.

OCD is deliberately not a wallet and does not custody funds or authorize
payments itself: keep your existing wallet and payment provider, and add
OCD once for policy evaluation, evidence, and reconciliation. Every result
— screening checks, preflight decisions, settlement observations,
deterministic findings — is wrapped in an Ed25519 attestation anyone can
verify independently, without trusting OnChainDiligence's servers.

Available over MCP (pay-per-call via x402, no API keys or accounts) and
HTTP/x402 directly, with an authenticated operator surface for private
operation history, recovery guidance, account-scoped webhooks, and
investigation/evidence export for support and compliance review.

## Capabilities

- Payment preflight — structured, deterministic ALLOW / REQUIRE_APPROVAL / BLOCK evaluation against a caller-defined policy, before payment
- Structured policy evaluation — wallet sanctions screening (Chainalysis oracle), OFAC name screening, UK company verification (Companies House), US company verification (SEC EDGAR), combined diligence
- Independent settlement observation — where OCD's finality/observation model supports the network and asset
- Verifiable receipts — every result signed (Ed25519), independently verifiable without trusting OCD's servers
- Investigation / findings — a deterministic engine that surfaces contradictions, uncertainty, and mismatches already present in existing evidence (no AI analyst, no fraud scoring)
- Caller-reported merchant response evidence — an explicit, honestly-labeled channel for recording what a merchant returned after payment, never claimed as independently verified by OCD

## Protocol surfaces

- **MCP** — `https://mcp.onchaindiligence.com/mcp` (Streamable HTTP; already listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=onchaindiligence) as `com.onchaindiligence/compliance`)
- **x402** — pay-per-call HTTP routes on Base (USDC), several Bazaar-discoverable (see `docs/BAZAAR_ACTIVATION.md`)
- **HTTP/API** — `https://api.onchaindiligence.com` for direct API integration outside MCP/x402

## Public MCP URL

`https://mcp.onchaindiligence.com/mcp`

## What NOT to claim (do not include in the submitted copy)

- Fraud detection — OCD reports evidence contradictions, never intent
- Custody — OCD never holds funds
- Guaranteed safety — screening and preflight are evidence-based checks, not a safety guarantee
- Service delivery verification — merchant responses are caller-reported only; OCD never claims to have independently verified that a merchant delivered a service
- Any PayBox partnership — OCD is compatible with PayBox as one execution provider among others, not a formal partnership (see `docs/PAYBOX_COMPATIBILITY_POSITIONING.md`)

## Keywords / tags (5–10)

`compliance`, `payments`, `x402`, `sanctions-screening`, `agent-payments`, `mcp`, `stablecoin`, `receipts`, `reconciliation`, `evidence`
