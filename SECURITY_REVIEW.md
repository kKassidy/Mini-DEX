# Task7: AI-assisted security review

## Scope and methodology

The source-code review examined pre-fix HEAD
`4d1d43c9072ea9ef82cfcb5dddc3da3d21850bf0` (`4d1d43c`). Mini-DEX is a
hybrid DEX: the on-chain Vault holds custody, while the backend maintains
balances, orders, matching, and settlement off-chain.

This was an AI-assisted, source-code-based review covering:

- EIP-712 login, JWT authorization, and user/address binding.
- Deposit ingestion and off-chain balance crediting.
- Available/locked ledger invariants and accounting.
- Order placement, cancellation, matching, and settlement.
- Withdrawal authorization/signing and `Vault.withdraw`.
- Replay, duplicate processing, races, and error handling.

The review traced production code and existing tests, with file-free in-memory
checks and mocked RPC inputs for selected failure paths. No live exploit
transactions were performed. This was a focused review, not a comprehensive
security certification. Existing self-trade protection was not used as the
Task7 advanced finding. The implementation and regression tests for the selected
fix were subsequently manually reviewed and approved.

## Fixed finding: Dust deposit aborts event processing/recovery

**Severity: High.** A valid, inexpensive on-chain deposit could interrupt
accounting for other events and poison historical recovery.

**Affected path:** `server/src/chain.ts` — `createChain`'s `backfill` and
`watchDeposits` live `onLogs` handler — through `routes.ts`'s `onDeposit` to
`Ledger.credit` in `ledger.ts`.

### Root cause and previous behavior

`weiToFixed` converts 18-decimal WAVAX to the eight-decimal ledger by integer
division by `10^10`. Positive deposits below `10^10` wei therefore become `0n`.
These are valid positive on-chain deposits, but both ingestion paths previously
passed the converted zero to `onDeposit`, which called `Ledger.credit(0)`.
The ledger's positive-amount check then threw.

- **Live batches:** the exception exited the callback before later valid events
  in that batch could be credited.
- **Historical replay:** the exception rejected backfill. The existing error
  handler logged the failure and switched to watching new events, leaving
  historical recovery incomplete. Later deposits could remain uncredited;
  skipped historical withdrawals could also leave previously credited balances
  overstated.

The failure was reproduced with mocked dust-then-valid event batches, without
live transactions.

### Minimal fix

At the chain ingestion boundary, both paths now skip only Deposit events whose
converted amount is exactly `0n`, using `continue` before calling `onDeposit`.
Historical processing also skips the credited-deposit counter increment. Its
guard is inside the Deposit branch, leaving withdrawal handling unchanged.

`continue` skips one event and processes subsequent logs. A `return` at either
loop location would instead exit the entire live callback or historical replay,
again preventing later events from being processed.

`Ledger.credit` retains its positive-amount invariant. No catch-and-ignore logic
was added; unrelated errors retain their existing propagation/reporting paths.
Representable deposits retain their previous conversions and credit behavior.
This patch does not accumulate fractional dust or change the existing fallback
policy for unrelated backfill failures.

## Regression evidence

The new `server/src/chain.test.ts` uses mocked RPC/account factories and a real
Ledger for credit assertions. No live network calls are needed.

| Coverage | Verified behavior |
| --- | --- |
| Historical dust followed by valid deposit | Only the valid deposit is credited; the credited counter excludes dust; replay completes and watching starts at `latest + 1`. |
| Live dust followed by valid deposit | Dust does not abort the batch; the later valid deposit is credited. |
| WAVAX boundaries in both paths | `1` wei and `10^10 - 1` wei are skipped; `10^10` wei credits one ledger unit. |
| Normal WAVAX/USDC deposits in both paths | Expected converted balances are preserved. |
| Unrelated callback error | A throwing live deposit callback still propagates its error. |
| Historical withdrawals | Withdrawal callbacks still receive their converted amounts, including zero. |

Validation completed after the implementation:

- New chain tests: **8 passed**.
- Full server suite: **56 passed across 6 test files**.
- `npm run typecheck`: **passed**.
- `git diff --check`: **passed**.

## Remaining findings

These source-supported findings were outside the selected patch. They are not
claims of observed exploitation or deployed configuration.

- **Restart recovery — Not fixed in this patch.** The in-memory ledger is rebuilt
  from deposits and withdrawals without persisted off-chain trades or pending
  withdrawal reservations. Following a restart, this can reconstruct incorrect
  balances or permit a second authorization while an earlier one remains valid.
- **Withdrawal lifecycle — Not fixed in this patch.** `/withdraw` debits before
  signing. A signing failure can leave the debit in place; abandoned or expired
  authorizations have no reconciliation/refund lifecycle. Signing-failure debit
  loss was reproduced with a rejecting signer stub.
- **Concurrent login nonce replay — Not fixed in this patch.** Nonce validation
  precedes asynchronous signature verification, and consumption follows it.
  Two concurrent requests using the same valid signed payload were observed to
  succeed. This requires possession of that payload and is not signature forgery.
- **Zero-quote tiny fills — Not fixed in this patch.** Truncated price-times-quantity
  arithmetic can yield zero quote payment while transferring a positive base
  quantity. This was reproduced in memory; the demonstrated per-fill value is
  tiny, limiting practical impact.
- **Development credential fallback — Not fixed in this patch.** Missing
  configuration can select public development defaults even in chain mode.
  If activated, these undermine authorization; a development signer used by the
  Vault would expose custody. The review did not establish that any deployment
  uses these defaults, and no credential values are included here.

## Security properties observed

- HTTP trading and withdrawal handlers obtain the acting identity from the
  verified JWT subject rather than a user-supplied owner field.
- Vault withdrawal signatures bind the sender (`msg.sender`), token, amount,
  nonce, deadline, and EIP-712 domain, including chain ID and verifying contract.
- The reviewed Vault checks expiry and used nonces, marks the nonce before token
  transfer, and uses reentrancy protection.

No supported bypass of those specific Vault checks was identified in this
review. These observations do not establish complete system security or resolve
the remaining backend findings above.

## Files changed by the fix

- `server/src/chain.ts`: two deposit-only converted-zero guards.
- `server/src/chain.test.ts`: eight deterministic regression tests.

`SECURITY_REVIEW.md` documents the review and fix. No changes to routes, conversion
helpers, ledger invariants, contracts, or deployment code were part of this fix.
