# Distribution Priority (D2.10, Section 5)

Status: **planning document only.** Ranks the distribution channels
prepared under D2.10 (plus the deployment step they depend on) by effort,
expected distribution value, dependency, when to execute, and whether code
is required. No execution ordering here has been carried out — this is
sequencing guidance for after the D2.6 live reference passes review.

| # | Channel | Effort | Expected distribution value | Dependency | When to execute | Requires code? |
|---|---|---|---|---|---|---|
| 1 | **Close D2.6** (finish independent review, confirm live reference) | Low (review only, already built) | N/A — gates everything else | Codex's final review | Now, in progress | No (frozen; do not touch) |
| 2 | **Verify OCD Bazaar activation** (`docs/BAZAAR_ACTIVATION.md` checklist) | Low — one real settlement + a read-only verification query | Medium — passive discovery inside the x402/Bazaar ecosystem, no submission gatekeeper | D2.6 closed (needs the live executor stable before spending real settlement effort) | Immediately after D2.6 closes | No (routes already built; only a settlement + verification, no new code) |
| 3 | **Submit AgentNDX listing** (`docs/AGENTNDX_LISTING.md`) | Low — copy is ready, submission itself is a form | Medium-high — a maintained agent directory is a direct discovery surface for exactly OCD's target integrators | None blocking (copy doesn't depend on D2.6, but positioning references the reviewed executor) | After D2.6 closes, so the listing can truthfully reference a live, reviewed payment reference | No |
| 4 | **Deploy D2.7 / D2.8A / D2.9A and start pilot** | Medium — merge three already-open, already-reviewed-once PRs per repo, deploy, run pilot readiness scripts | High — this is the actual product surface (operation history, findings, merchant evidence) that gives OCD something substantive to point AgentNDX/OpenAI listings at | D2.6 closed (these all build on the same operation/lifecycle model, and merging early risks compounding review scope with the in-flight D2.6 review) | After D2.6 closes; before OpenAI packaging, since a pilot gives real usage evidence for that submission | Yes — merges, deploy, no new feature code beyond what's already in the open PRs |
| 5 | **Package OpenAI Plugin/App** (`docs/OPENAI_PLUGIN_PLAN.md`) | Medium-high — several open "needs verification" items (icon assets, review turnaround, demo-account handling for a keyless/pay-per-call tool), plus tool-annotation code changes | High if accepted — largest potential reach (ChatGPT's user base), but gated by OpenAI's own review process and the unresolved authentication-model question | D2.6 closed; ideally D2.7-9 deployed (gives OpenAI reviewers a working pilot surface + resolves the demo-account question with real usage) | After items 1-4; resolve the "needs verification" items first | Yes — tool annotations on `preflight_payment`, plus whatever privacy-policy/asset work the verification items surface |
| 6 | **Anthropic enterprise MCP readiness** | Unscoped — no work has been prepared under D2.10, deliberately not started | Unknown — no enterprise demand signal yet | Real customer/pilot demand | Only when demanded — do not build ahead of demand | Unknown, not scoped |

## Recommended sequencing

1. Close D2.6 (independent review currently in progress — not our action item).
2. Verify OCD's own Bazaar activation (one settlement + a read-only check).
3. Submit the AgentNDX listing.
4. Merge and deploy D2.7A / D2.8A / D2.9A; start the pilot.
5. Resolve the OpenAI Plugin/App "needs verification" items and package the
   narrow preflight-only workflow.
6. Revisit Anthropic enterprise MCP work only if and when a customer or
   pilot signal actually asks for it — not proactively.

This mirrors the ordering given in the D2.10 task directly; nothing here
invents new D3-scope work, and no step in this table has been executed as
part of this task.
