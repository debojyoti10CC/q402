# Q402 threat model

## Assets

1. Agent balances on the rollup (prepaid budget for API calls).
2. Provider earnings on the rollup and their withdrawal to L1.
3. Request and response contents (prompts, queries, paid data).
4. The rollup's escrow on QoreChain.

## Actors

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Agent | its own spending | anything else |
| Provider | serving data after payment | holding agent funds |
| Facilitator (posts txs, pays L1 fees) | liveness only | funds, data |
| Operator (batch submitter) | liveness only | state correctness |
| Watchtower | nothing: anyone can run one; one honest one is enough | — |
| QoreChain L1 | consensus, inbox ordering, fraud decision | — |

## Threats and mitigations

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | **Q-Day: classical keys broken.** An attacker with a quantum computer derives ECDSA keys. | Agent payments are ML-DSA-44 signed qledger-v1 transfers; there is no classical key on L2. L1 transactions are hybrid (secp256k1 + ML-DSA-87); batches are anchored with ML-DSA-87. A recovered secp256k1 key alone cannot sign. | Built |
| T2 | **Harvest now, decrypt later.** Traffic recorded today is decrypted after Q-Day. | Request and response bodies are sealed with ML-KEM-1024 envelopes bound to chain id and rollup id. The facilitator and operator never see plaintext. | Built |
| T3 | **Dishonest operator mints or steals** by publishing a false state root. | Watchtower re-executes every batch from the inbox and submits a fraud proof; the chain re-executes qledger-v1 itself and rejects the batch and all later ones; the submitter's bond is slashed. Shown live with the "Evil sequencer" button. | Built (mock), live untested |
| T4 | **Operator censors** an agent or provider. | Based sequencing: anyone can post a transaction to the inbox on L1 and every batch must consume the inbox in order. A censored party posts directly. | By design of qledger-v1; not demoed |
| T5 | **Replay** of a payment to another rollup or chain. | Signatures cover chain id + rollup id (`qledgerSigningMessage`); nonces are sequential per account. | Built |
| T6 | **Double spend** across two providers before inclusion. | Facilitator verifies against balance minus all in-flight payments and the next nonce. Only one tx per nonce can execute. | Built; assumes one facilitator |
| T7 | **Provider takes payment and does not serve.** | Out of scope for v1. Amounts per call are tiny; agents keep per-call and session limits. A refund/dispute flow is future work. | Partial |
| T8 | **Runaway agent** spends its budget. | Per-call cap and session budget enforced in the agent wallet before signing. | Built (client-side) |
| T9 | **Malicious 402 response** asks a different rollup, recipient or price. | Agent checks network, rollup id and price against its limits before signing; payTo is shown in the tool result. | Built |
| T10 | **Withdrawal theft or double withdrawal.** | Withdrawals are leaves in the batch's withdrawals root and pay only after finality, once per index, to the recipient the provider signed. | Built (mock), live untested |
| T11 | **Facilitator goes down.** | Payments are ordinary signed transactions; any party can post them to the inbox. | By design |

## Known limitations

- The live testnet path is written against RDK 0.9 but has not run yet (rollup stake pending).
- The mock L1 does not model fees, bonds or real ML-DSA-87 anchoring.
- One post per payment on L1: posting fees (~3.8 KB per ML-DSA-44 transfer) are paid by the facilitator. Aggregating payments with channels is future work.
- Demo identities are stored in `.devkeys.json` (git-ignored, testnet only).
