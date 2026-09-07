# D2.10C — OpenAI Plugin submission package

Status: implementation and local checks complete; production verification recorded below after deployment. NOT SUBMITTED.

## Scope and official sources (checked 7 September 2026)

Submission-ready, MCP-only/tool-only Plugin. No widget, UI resources, screenshots or widget CSP needed. Universal URL: `https://mcp.onchaindiligence.com/public/mcp`. No authentication, demo account, payment, subscription or wallet setup.

Current official documentation uses **Plugins**; legacy Apps SDK URLs redirect. Consulted:

- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/app-guidelines
- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/build/examples
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/plugins/reference

Use `chatgpt-app-submission.json` at this repo's root for the submission-import flow described by the chatgpt-app-submission skill. It uses that skill's exact schema (app info, tools and justifications, five positive and three negative cases). If the current portal does not offer import, copy these values into the corresponding fields; do not claim an import or draft was created. URL/auth/logo/countries/release notes are portal fields, not extra keys invented in this JSON format.

Name: OnChainDiligence. Subtitle: Inspect and verify payments. Category: FINANCE (policy inspection and receipt evidence, not financial advice or transfer execution).

The existing `/mcp` lists six x402-paid digital-service tools. Current Plugin commerce rules prohibit digital-service sales/checkout and execution of money or crypto transfers. It is not submitted, re-priced or made globally free. `/public/mcp` has a separate SDK server registration and never calls the paid handler. No skills import or company-knowledge search/fetch interface is needed for this specific compute/exact-receipt workflow.

## Submitted tool review

| Tool | readOnlyHint | openWorldHint | destructiveHint | Implementation |
| --- | --- | --- | --- | --- |
| inspect_payment | true | false | false | Existing inspectPayment / deterministic policy evaluator; external screening explicitly disabled; no receipt or persistence. |
| get_receipt | false | false | false | Existing getReceiptById / public resolver; exact public-only database SELECT and bundled fallback; corruption can log a diagnostic. |
| verify_receipt | false | false | false | Existing verifier; public lookup or caller envelope, fixed OCD key-registry fetch; public lookup can log corruption. |

The last two readOnlyHint values are deliberately conservative under OpenAI's explicit **log-write** definition; neither mutates business records or causes payments. Existing paid-surface annotations are unchanged, not copied or endorsed for submission. Repeat calls are non-transactional; no provider, signing or settlement action is registered.

All three currently omit `outputSchema`, as do the reused tool definitions. Existing TypeScript result types are not runtime JSON schemas. This is a review warning, not a fabricated schema or a new verification format: add an accurate outputSchema so models can use results more reliably. See https://modelcontextprotocol.io/specification/draft/server/tools#tool.

## Input/output minimization

Inputs are bounded proposal/policy fields, public receipt IDs, or an envelope the user may share. No account IDs, capabilities, API keys, wallet keys, payment authorizations, debug arguments or arbitrary fetch URLs are requested. Resource URLs are compared by origin, never fetched. Envelopes can contain user data: the descriptor asks for permission to share and prohibits secrets. They are verified without publication and not echoed. Transport bodies are capped at 64 KiB. Errors do not expose backend exception details.

Public signed envelopes are returned unchanged inside `{found:true,envelope}` so their signatures remain checkable; no private receipt access or enumeration is added. Signed receipt IDs/digests, public addresses, transaction hashes and signed claims are essential evidence, not removable debug fields. Verification returns only state/code/message and an optional resolution error. Private and unknown receipt IDs remain indistinguishable. Receipt content is untrusted data, never instructions. No widget CSP exists because there is no widget.

Privacy disclosures explicitly distinguish application data from Vercel/security logs. The wider-product lifecycle cache can retain a raw finalization capability despite the authorization table using a hash; webhook signing secrets also remain server-side. Neither is exposed by these tools. This corrects an overbroad hash-only statement in older pilot notes without altering lifecycle behavior.

## Public materials

- Website: https://onchaindiligence.com
- Privacy: https://onchaindiligence.com/privacy
- Terms: https://onchaindiligence.com/terms
- Support: https://onchaindiligence.com/support — support@onchaindiligence.com
- Brand: existing site logo/seal; operator uploads/selects an existing production-ready logo, no new artwork created.

The prior live `/terms` was a placeholder draft. Replacement Terms, separate Privacy and Support use its existing fonts, colours, seal and layout. They disclose no automatic retention/deletion period, no self-service account/operation deletion, caller-reported merchant evidence, and best-effort support. Publisher legal identity/address and applicable legal requirements must be confirmed by the operator before submission; no entity, jurisdiction, contractual SLA or liability cap was invented.

## Review cases and starter prompts

Exactly five positive cases are in the JSON: inspect within a cap; inspect an over-cap proposal; retrieve public reference `OCD-RCP-EMG6-6KR4-PQSG-MZPQ`; verify that public reference; reject a malformed envelope. This is an already-public non-execution reference, not the historical D2.6 operation. Baseline live verification returned VALID before deployment.

Exactly three negative cases: send a payment; guarantee safety/compliance; custody and automatically trade crypto. Tools must not be invoked to carry out these unsupported requests. No production fixture, account, operation or payment is created.

Starter prompts:

1. Compare my proposed payment with a maximum amount I specify.
2. Retrieve a public OCD receipt by its receipt ID.
3. Verify the proof of a public OCD receipt and explain its limits.

Release notes: Initial free, MCP-only submission for deterministic payment inspection and public receipt retrieval/verification. No payment execution, custody, screening, checkout, account or widget. Existing paid OCD services remain separate. Review uses an existing public reference and needs no credentials.

## Operator portal checks — not code blockers

- Confirm verified developer/business identity matches the publisher, website and policy disclosures; supply the legal operator/contact details required for the selected regions.
- Confirm Apps Management Write (`api.apps.write`) on the correct organisation/project. Do not infer status from repository ownership.
- Confirm project residency is eligible (current MCP review docs exclude EU-data-residency projects).
- Choose countries only where publisher, terms and support are ready; no worldwide availability claim is made here.
- Upload/select the existing logo and choose FINANCE; no screenshots for a no-UI Plugin.
- Authentication: none; no demo credentials or signup needed.
- Test in ChatGPT/Codex developer mode and review tool selection against the five positive/three negative cases. Direct MCP tests do not substitute for this host-loop check.
- If prompted, set the **exact single** portal token as production `OPENAI_APPS_CHALLENGE` on the MCP project using the host's secret/configuration UI, redeploy, and verify `https://mcp.onchaindiligence.com/.well-known/openai-apps-challenge`. The route is 404 when unconfigured and serves only the token as non-cacheable plaintext when configured. No token is invented, read from a file or committed. Check for another Plugin's existing challenge before replacing anything.
- Scan Tools, import/copy metadata, review release notes, availability and policy attestations, then the owner may choose Submit for Review. This task does not create a draft, submit or publish a Plugin.

## Validation

Local typecheck passed. `node --import tsx --test test/publicMcp.ts`: six focused checks covering discovery, deterministic results, public-only retrieval, invalid-envelope/errors, paid-tool exclusion/body limit, challenge and submission shape. No broad regression matrix or production resource creation.

D3: **NO COMMITMENT UNTIL REAL PILOT DEMAND**.
