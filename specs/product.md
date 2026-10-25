# Product
- Project Krypto is an autonomous ETH/USDC **paper-trading** proof of concept, permanently paper-only in every environment. Wallets, custody, exchange orders, transfers, and model-accessible mutating tools are not product features; there is no future execution mode or approval path to enable.
- `main` is the release branch. Development and production are real Azure deployment environments, not different financial execution capabilities.
- The owner's standing research mission is encoded in `autonomy.tradingResearch`
  in `.github/agentic-policy.json`: evaluate the requested net daily-profit
  hypothesis against its stated starting paper capital. The target is aspirational,
  not an income guarantee. Assess feasibility with losing days, fees, slippage,
  drawdown and out-of-sample evidence; never add leverage or weaken safeguards
  to force target attainment.
- The model returns exactly one structured `HOLD`, `BUY`, or `SELL` proposal; deterministic policy, guardrails, reconciliation, idempotency, the owned expiring lease, and the transactional paper executor alone authorize state.
- `disabled` does no trading work, `shadow` records without execution, and `paper` records simulated fills; failures are journaled and surfaced.
- Core limits remain code-enforced: cooldown, exposure/DCA/size caps, mandatory stop-loss, drawdown lock, operator pause, fixed-point accounting, modeled fees, and immutable run/trade/journal evidence.
- Admin/auth surfaces remain signed, same-origin, and explicit about paper, paused, locked, destructive, and disabled states.
- This file defines product behavior. Standing software-delivery authority and separately scoped deployment settings, secrets/accounts, and commissioning effects are defined in `specs/governance.md`.
