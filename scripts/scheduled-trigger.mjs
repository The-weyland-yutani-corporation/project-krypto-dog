#!/usr/bin/env node
// Thin CLI bootstrap for the Azure Container Apps Jobs scheduled trigger.
//
// Run with:
//   node --experimental-strip-types scripts/scheduled-trigger.mjs
//
// Kept as plain JavaScript (not TypeScript) and as the sole file that
// imports src/deployment/scheduled-trigger.ts by relative path, because
// Node's ESM resolver requires an explicit file extension for relative
// specifiers, and this repo's shared tsconfig (which this change does not
// own or modify) does not enable `allowImportingTsExtensions` for `.ts`
// extension imports. A plain `.mjs` bootstrap is outside that TypeScript
// project graph entirely, so it can use the explicit `.ts` specifier Node
// needs without introducing a new typecheck error anywhere else.
//
// See src/deployment/scheduled-trigger.ts for validation rules, required
// environment variables (TARGET_BASE_URL, SCHEDULED_ROUTE, CRON_SECRET,
// ROLLOUT_MODE), and the single-attempt/no-retry behavior. Exits 0 on a 2xx
// response, 1 otherwise. Never logs CRON_SECRET or any other secret value.
import { main } from "../src/deployment/scheduled-trigger.ts";

await main();
