# Product
- Project Krypto is an autonomous ETH/USDC **paper-trading** app; live trading, wallets, custody, exchange orders, and model-accessible mutating tools are absent and unauthorized.
- The model returns exactly one structured `HOLD`, `BUY`, or `SELL` proposal; deterministic policy, guardrails, reconciliation, idempotency, the owned expiring lease, and the transactional paper executor alone authorize state.
- `disabled` does no trading work, `shadow` records without execution, and `paper` records simulated fills; failures are journaled and surfaced.
- Core limits remain code-enforced: cooldown, exposure/DCA/size caps, mandatory stop-loss, drawdown lock, operator pause, fixed-point accounting, modeled fees, and immutable run/trade/journal evidence.
- Admin/auth surfaces remain signed, same-origin, and explicit about paper, paused, locked, destructive, and disabled states.
- Production deployment, secrets, external accounts, architecture acceptance, and any paper/live boundary change are human-only; code and `DESIGN.md` are authoritative for implementation detail.
