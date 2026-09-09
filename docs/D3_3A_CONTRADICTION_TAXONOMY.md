# D3.3A: contradiction taxonomy

> A contradiction is emitted only when sufficient evidence establishes that two relevant facts disagree. Missing or unresolved evidence is not a contradiction.

D3.3A is an internal, deterministic vocabulary and rule matrix. It does not change Action Receipt v1, Commerce Lifecycle v1, database storage, public APIs, MCP tools, or the current D2.8 findings output. D3.3B will map durable lifecycle facts into these rules.

## Classes and V1 codes

`CONTRADICTION`: `AMOUNT_MISMATCH`, `ASSET_MISMATCH`, `RECIPIENT_MISMATCH`, `NETWORK_MISMATCH`, `POLICY_CONSTRAINT_VIOLATION`, `EXECUTION_STATUS_CONTRADICTION`, `SETTLEMENT_STATUS_CONTRADICTION`, `DUPLICATE_EXECUTION`, `PAYMENT_IDENTITY_MISMATCH`, `TEMPORAL_CONSTRAINT_VIOLATION`.

`INSUFFICIENT_EVIDENCE`: `EXECUTION_NOT_INDEPENDENTLY_OBSERVED`, `SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED`, `PAYMENT_IDENTITY_UNRESOLVED`, `ATTRIBUTION_UNRESOLVED`, `REQUIRED_EVIDENCE_MISSING`.

Findings carry a class, code, machine-readable expected/observed facts, existing evidence references, evidence-source roles, and a concise explanation. They do not carry scores or confidence percentages.

## Rule matrix and preconditions

Before a payment-field mismatch is evaluated, OCD must establish source, attribution/binding, and canonical comparable values. An unrelated or merely possible transfer is `ATTRIBUTION_UNRESOLVED`, not a mismatch.

| Rule | Contradiction precondition | Otherwise |
| --- | --- | --- |
| Amount / asset / recipient / network | Mandate value + attributable independent observation + unequal canonical values | Missing or unresolved attribution is insufficient evidence |
| Policy constraint | Explicit maximum, allowlist, or allowed-network constraint + attributable observed violation | `ALLOW` alone creates no policy rule |
| Execution / settlement status | Executor terminal claim and incompatible independently established terminal status | Missing or `UNVERIFIED` observation is insufficient evidence |
| Duplicate execution | One execution authorized + more than one distinct stable attributable execution identity | Repeated copies of one transaction are not duplicates |
| Payment identity | Expected identity and independently established conflicting identity | `TRANSFER_MATCH_ONLY` is `PAYMENT_IDENTITY_UNRESOLVED` |
| Temporal | Explicit deadline and authoritative attributable execution time after it | Missing/non-canonical timing is insufficient evidence |

## Canonical comparison

- Amounts are non-negative integer atomic units and compare with `BigInt`; no floating point or rounding.
- EVM addresses must validate as 20-byte hex addresses and compare lowercase; checksum case alone is not a mismatch.
- Contract-address assets compare as normalized addresses; other canonical asset identities compare exactly. Ticker text is not used as identity.
- Networks must be CAIP-2 identifiers; display labels such as `Base` are rejected rather than guessed.
- Duplicate detection only accepts stable execution identities and de-duplicates identical identities before comparison.
- Times must be exact UTC timestamps supplied as authoritative evidence. The rules use no wall-clock time.

## Claim limits

D3.3 findings do not determine fraud, malicious intent, compliance, safety, service delivery, or objective truth beyond the evidence compared. `UNKNOWN`, `UNVERIFIABLE`, delayed indexing, missing observation, and weak transfer-only binding are not contradictions by themselves.

## Roadmap status

- D3.3 Contradiction Taxonomy: **ACTIVE**
- D3.3A Contradiction Vocabulary + Deterministic Rules: **COMPLETE**
- Next: D3.3B Deterministic Detection Engine
