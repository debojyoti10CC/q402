# Q402: pay-per-call APIs for AI agents, on a post-quantum rollup

AI agents are starting to pay for the APIs they call: x402 and MCP payments
won top prizes at the largest crypto hackathons of 2025 (MCPay, Corbits, zkx402).
Every one of those designs signs payments with ECDSA, which a quantum computer
breaks. **Q402 is the same idea built to survive Q-Day**: a QoreChain rollup where
agents pay per call with post-quantum signatures, request and response data is
sealed with ML-KEM, and a watchtower stops a dishonest operator with fraud
proofs the chain checks itself.

Built for **Build Before Q-Day** (QoreChain Developer Fest), category **Protocol Builders**.

## How it works

```
 Claude (MCP)          Provider API            Facilitator / Operator          QoreChain (L1)
 q402-wallet  --POST-->  /api/weather  ----->  verify ML-DSA-44 transfer
              <--402---  price, payTo,          queue + post to rollup inbox ---> rdk inbox (based sequencing)
              --POST-->  signed transfer,       every few s: execute qledger-v1,
                         request sealed         submit batch (ML-DSA-87 anchored) ---> settlement batch
              <--200---  response sealed                                     
                         to the agent           Watchtower: re-execute, on a lie
                                                send fraud proof -------------------> chain re-executes,
                                                                                      rejects the batch
                         Provider withdraws ---> withdrawal in a batch --finality--> paid on L1 (Merkle proof)
```

| Track requirement | Where |
|---|---|
| ML-DSA-signed batches | Every payment is an ML-DSA-44 signed qledger-v1 transfer; every batch is anchored with the creator's ML-DSA-87 signature (`src/node/operator.ts`, `submitBatch` with `anchor: "auto"`) |
| Withdrawal | Provider withdraws its earnings: qledger withdraw tx → batch withdrawals root → `executeWithdrawal` with Merkle proof after finality (`src/provider/server.ts`, `src/node/operator.ts`) |
| Verified settlement receipt | `GET /receipt/:batch` → `buildSettlementReceipt` + `verifySettlementReceipt` from the RDK (`src/l1/live.ts`) |
| Watchtower | Independent re-execution and fraud proofs with `buildQledgerFraudProof` (`src/node/watchtower.ts`) |
| ML-KEM data protection | Requests and responses sealed with ML-KEM-1024 envelopes bound to chain + rollup (`src/core/seal.ts`) |
| Threat model | [THREAT_MODEL.md](THREAT_MODEL.md) |

## Run it (no tokens, no accounts)

Needs Node.js 20+.

```bash
npm install
npm run demo        # 14 end-to-end checks, ~40 s, exits non-zero on failure
```

Interactive (three terminals):

```bash
npm run devnet      # mock L1 + facilitator + operator + watchtower + dashboard on :8402
npm run provider    # paid API on :8403
npm run agent -- burst 10          # or: weather Kolkata | price ethereum | wallet
```

Open http://localhost:8402, then press **Evil sequencer** and make one more call:
the next batch mints 50 QOR to the operator, the watchtower proves it wrong, the
batch is rejected and an honest one replaces it.

### Use it from Claude

Add the MCP server to Claude Desktop (`claude_desktop_config.json`) or Claude Code:

```json
{
  "mcpServers": {
    "q402-wallet": {
      "command": "npx",
      "args": ["tsx", "src/agent/mcp.ts"],
      "cwd": "<path to this repo>"
    }
  }
}
```

Tools: `get_weather`, `get_crypto_price`, `wallet_status`. Limits come from
`Q402_MAX_PER_CALL` and `Q402_SESSION_BUDGET` (uqor).

## Mock vs. live

`Q402_MODE=mock` (default) runs an in-memory L1 that uses the RDK functions that
reproduce the chain's own rules: inbox accumulator, range commitment, qledger-v1
execution and the fraud decision (`checkQledgerFraud`). It skips consensus, fees,
bonds and real anchoring.

`Q402_MODE=live` uses the QoreChain testnet through `@qorechain/rdk`.
**Status: written, not yet run end to end.** Creating a rollup needs a stake of
10,000 test QOR (`min_stake_for_rollup` on `qorechain-diana`), which the faucet
does not give. Once the operator account holds it:

```bash
cp .env.example .env    # set Q402_MODE=live and QORE_MNEMONIC (fresh testnet-only wallet)
npm run setup:live      # dry run
npm run setup:live -- --yes
npm run devnet
```

Rollup id: `q402-pay`. Testnet addresses used: _to be added after setup_.

## Layout

```
src/core      config, test identities, x402-style types, ML-KEM sealing
src/l1        L1Backend interface, MockL1, LiveL1 (RDK)
src/node      facilitator, operator (batch submitter), watchtower, dashboard
src/provider  the paid API
src/agent     agent wallet, MCP server, CLI
scripts       demo (end-to-end checks), setup-live
```

## Credits

Built with the QoreChain kits: `@qorechain/rdk` (qledger-v1, batches, fraud
proofs, envelopes, receipts) and `@qorechain/sdk`. Also `@modelcontextprotocol/sdk`,
`zod`, `dotenv`, `tsx`, TypeScript. Data from Open-Meteo and CoinGecko public APIs.
Idea inspired by x402 (Coinbase) and MCPay. See [AI_USAGE.md](AI_USAGE.md) for how AI was used.

## License

Apache-2.0
