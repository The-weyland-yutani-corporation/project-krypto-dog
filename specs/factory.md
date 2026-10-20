# Factory

- The standing `autonomy` mission in `.github/agentic-policy.json` authorizes
  same-repository idea-to-main delivery without per-change human approval.
  Its bot-created goal must match the policy body, scope, and milestone exactly.
- The queue controller creates that goal once, owns claims, and dispatches at
  most one implementation per pass. Assignment limits reset at midnight UTC;
  WIP does not reset. Missing or malformed claim timestamps consume budget.
- Exactly one `factory-control` issue remains the emergency switch:
  `active`, `shadow`, or `paused`. Missing/ambiguous means paused. The scheduled
  loops never clear a pause. The current activation label requires a human
  timeline event even in autonomous mode; this one-time/resume authorization
  is separate from per-change software approval.
- The intake controller shares the queue's concurrency group. It explicitly
  dispatches discovery, triage, architecture review, and planning so bot-written
  labels do not depend on GitHub event recursion. Discovery is capped at one
  dispatch per UTC day; each issue/stage at two attempts per UTC day. An active
  workflow suppresses duplicate dispatch. Uncertain dispatch is not retried
  within the same pass.
- Native goal relationships, exact allowed paths, closed dependencies, owned
  expiring claims, and unique assignment/PR provenance remain required.
  Legacy issues are not silently adopted into the standing mission.
- Risk selects automated verification. Routine changes require quality,
  migrations, and code review; sensitive/boundary changes add QA and applicable
  security/trading-safety checks. Boundary risk alone does not require a human.
  Malformed or missing evidence never authorizes merge.
- The merge controller verifies immutable verdict receipts from trusted
  workflow runs, then performs a native GitHub merge bound to the exact
  checked SHA. It does not leave a future head armed for auto-merge.
  Review runs also require the controller's immutable dispatch receipt and
  random nonce, with the original and rerun actor verified as the trusted bot.
  Controller reruns require the exact recorded attempt and unchanged stable
  initiating identity; another actor's rerun cannot inherit that authorization.
  Labeling an arbitrary PR never grants factory ownership. Publication repeats
  current claim, scope, review and receipt verification before the mutation.
  GitHub branch protection remains effective. Forks are outside unattended
  same-repository delivery. Explicit review vetoes and emergency stops remain.
- Repairs are capped and restricted to the existing issue scope. Exhausted or
  unsafe work is reported rather than deleting tests or weakening checks.
- Exact-SHA development/deployment evidence is separate from a successful
  merge. Production rollout is not proven by local tests or a merged PR.
  The application remains non-live: real-money execution and transfers are
  outside automated software-delivery effects.