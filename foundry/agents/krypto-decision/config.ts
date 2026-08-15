export const KRYPT0_DECISION_AGENT_DESCRIPTION =
  "Read-only ETH/USDC decision agent. Deterministic Project Krypto code retains all authorization and execution authority.";

export const KRYPT0_DECISION_AGENT_ENVIRONMENTS = {
  dev: {
    projectName: "krypto-dev-agents",
    agentName: "krypto-dev-decision",
    modelDeployment: "krypto-dev-luna",
  },
  prod: {
    projectName: "krypto-prod-agents",
    agentName: "krypto-prod-decision",
    modelDeployment: "krypto-prod-luna",
  },
} as const;

export type KryptoAgentEnvironment =
  keyof typeof KRYPT0_DECISION_AGENT_ENVIRONMENTS;
