# D3.3B detectability matrix

D3.3B uses the durable preflight journal, the existing operation investigation, and already-recorded observation/binding evidence. It adds no RPC calls, database writes, migrations, receipt fields, or MCP fields.

| D3.3A code | Current status | Runtime gate |
| --- | --- | --- |
| `AMOUNT_MISMATCH` | LIVE_DETECTABLE | Durable action amount converts exactly to atomic units; executor-correlated or identity-linked observation exists |
| `ASSET_MISMATCH` | LIVE_DETECTABLE | Durable asset contract and attributable observed asset contract exist |
| `RECIPIENT_MISMATCH` | LIVE_DETECTABLE | Durable recipient and attributable observed recipient exist |
| `NETWORK_MISMATCH` | LIVE_DETECTABLE | Durable CAIP-2 network and attributable observed network exist |
| `POLICY_CONSTRAINT_VIOLATION` | PARTIALLY_DETECTABLE | Existing `max_amount`, `expected_recipient`, or `allowed_networks` is explicit and attributable observation exists. `allowed_assets` remains represented by `ASSET_MISMATCH`; it has no separate D3.3A policy-rule input. |
| `EXECUTION_STATUS_CONTRADICTION` | NOT_YET_DETECTABLE | Current binding state is not an independently comparable terminal executor claim. |
| `SETTLEMENT_STATUS_CONTRADICTION` | NOT_YET_DETECTABLE | Current path has OCD observation, but no separate authoritative terminal settlement claim to compare. |
| `DUPLICATE_EXECUTION` | NOT_YET_DETECTABLE | Append-only observations can represent reorg/re-observation; current mandate model does not provide a separately comparable execution-count authorization. |
| `PAYMENT_IDENTITY_MISMATCH` | NOT_YET_DETECTABLE | Binding strength is recorded, but both conflicting durable payment identities are not exposed together to this runtime adapter. |
| `TEMPORAL_CONSTRAINT_VIOLATION` | NOT_YET_DETECTABLE | Current finalization validity window is an operational TTL, not a customer-authorized temporal policy constraint. |
| `EXECUTION_NOT_INDEPENDENTLY_OBSERVED` | PARTIALLY_DETECTABLE / dormant | Defined in D3.3A; current runtime does not model a terminal executor claim as `CONFIRMED` without independent evidence. |
| `SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED` | PARTIALLY_DETECTABLE / dormant | Defined in D3.3A; no distinct settlement claim is currently persisted. |
| `PAYMENT_IDENTITY_UNRESOLVED` | PARTIALLY_DETECTABLE / dormant | Defined in D3.3A; requires an expected identity, not merely a payer commitment. |
| `ATTRIBUTION_UNRESOLVED` | LIVE_DETECTABLE | Observation exists but only `TRANSFER_MATCH_ONLY` binding is available. One deduplicated finding is emitted. |
| `REQUIRED_EVIDENCE_MISSING` | PARTIALLY_DETECTABLE | Only for an applicable comparison with a durable obligation; never for a never-submitted operation. |

## Binding matrix

- `TRANSFER_MATCH_ONLY`: does not establish operation causality for mismatch comparison. It can emit one `ATTRIBUTION_UNRESOLVED` finding, never a mismatch.
- `EXECUTOR_CORRELATED`: sufficient for existing amount, asset, recipient, network, and explicit-policy comparisons.
- `PAYMENT_IDENTITY_LINKED`: also sufficient for those comparisons. It is not by itself an identity mismatch; that requires conflicting identities.

## Coexistence and order

D3.3 records map into the existing `Finding` response representation. Exact D2.8 duplicates (`AMOUNT_MISMATCH` and `RECIPIENT_MISMATCH`) are suppressed by code only when D3.3 has established the same code. All other D2.8 findings remain unchanged.

D3.3 output is stable: contradictions first, then insufficient-evidence findings, then canonical V1 code order. Duplicate missing-attribution records collapse to one code, preventing finding spam.

## Roadmap status

- D3.3A Vocabulary + Deterministic Rules: **COMPLETE**
- D3.3B Deterministic Detection Engine: **COMPLETE / LIVE**
- Next: D3.3C Findings Product Presentation
