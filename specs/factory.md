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
- PR reviewers establish the exact base/head revisions and inspect their
  committed merge-base-to-head diff. Restored trusted instructions, synthetic
  merge checkouts, and physical file modes are not evidence of PR changes.
  Mode-change findings require committed tree metadata. Missing history,
  incomplete pagination, or omitted patches must be resolved from authoritative
  data; otherwise the review fails as incomplete, not as an invented source
  defect or a successful empty diff.
- General code review does not duplicate the independently required specialist
  audits or completed exact-head CI. Delegated scopes must not overlap, and
  complete diff coverage and verdict quality remain required. Budget exhaustion
  blocks review; it never authorizes an alternate run, weaker review, or merge.
- GH-AW v0.81.6 skips its native daily-credit guard for `workflow_dispatch`.
  Trusted queue, intake and PR controllers therefore check recorded credits
  before claiming work, minting a dispatch receipt or requesting an agent run.
  Limits come from their trusted checkout's workflow frontmatter, not a second
  policy list. The check follows GH-AW's rolling 24-hour run-creation window
  and recorded usage threshold; it is not a hard account-billing cap.
  Complete native run history and its latest immutable usage cache are required.
  Missing, malformed, expired or ambiguous evidence fails rather than implying
  zero usage. Outstanding runs defer further work, including runs older than
  the credit window. Each workflow is admitted at most once per controller
  pass; uncertain reads or dispatches are not replayed in that pass.
  Credit exhaustion leaves work unclaimed and creates no review receipt or
  repair label. A later scheduled pass rechecks admission without clearing a
  factory pause. An estimated expiry is not authorization to dispatch, and
  independent native triggers are not covered by a distributed budget lock.
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
  Development and production are permanently paper-only. The lifecycle
  reconciler requires immutable native development evidence before
  `factory:deployed-dev`, then exact-merge paper-production and actual
  scheduled-run evidence before completion. Green commit statuses,
  disabled releases, mutation-free deferrals and labels alone cannot close
  an issue.
- Production delivery verifies the latest native run/attempt, all required
  jobs, bounded immutable receipt archives, the admitted development attempt
  and the receipt-bound native production Deployment. Missing, expired,
  ambiguous or superseded evidence fails closed; an older successful run
  cannot substitute for the latest attempt.
- Production failure recovery includes pre-promotion cutover and backup failures,
  not just failed activation. A persisted original-source context and bounded
  retained intent precede recovery mutation. Only a verified owned source or
  candidate may be disabled; required fence completion uses fresh signed proof
  in the existing deployment Environment. Mixed/unknown state stays explicitly
  retained and a mutation-free deferral stays untouched. Recovery receipts never
  convert a failed workflow into successful delivery or authorize factory resume.
  Schema-2 promotion evidence binds the new recovery job inventory; historical
  schema-1 evidence must still match its own exact inventory.
- A verified mutation-free continuous-production deferral may use the bounded
  retry policy in `.github/agentic-policy.json`. The controller consumes a
  native, claim/PR/SHA-bound comment ledger before dispatching the existing
  production workflow in `continuous` mode. It rechecks ownership, scope,
  main, native production and active factory state. Changed or pending
  attempts suppress duplicate dispatch. An uncertain write/dispatch is not
  replayed; failed, disabled and first-activation outcomes are not automatic
  retry authority. Exhaustion, unsafe evidence and the configured missing-
  production deadline block the issue and pause the factory.
- Completion rechecks the current claim, assignment, unique PR, allowed
  paths, exact merge and native delivery evidence, including after its audit
  comment. One native issue update applies `closed/completed` and
  `factory:done` together; the audit comment is intent, not completion.
  GitHub reads and the final mutation are not a distributed transaction.
- The bounded full canary changes only its heartbeat, requires the exact
  run link/time in the merged file, and independently verifies the same
  native production proof and final ownership before accepting closure.
  It does not dispatch production or activate a paused factory. These
  source controls do not assert that commissioning or the canary has run.