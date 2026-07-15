import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
      },
    ],
  },
  setupFiles: ["<rootDir>/tests/setup.ts"],
  collectCoverageFrom: [
    "src/agent/decision.ts",
    "src/deployment/preflight.ts",
    "src/lib/admin-auth.ts",
    "src/lib/admin-route-auth.ts",
    "src/lib/config.ts",
    "src/lib/indicators.ts",
    "src/lib/market-data-provider.ts",
    "src/lib/operations-health.ts",
    "src/trading/accounting.ts",
    "src/trading/paper-execution.ts",
    "src/trading/policy.ts",
    "src/trading/strategy-config.ts",
  ],
  coverageThreshold: {
    global: {
      statements: 88,
      branches: 75,
      functions: 90,
      lines: 88,
    },
    "./src/agent/decision.ts": {
      statements: 95,
      branches: 75,
      functions: 100,
      lines: 95,
    },
    "./src/deployment/preflight.ts": {
      statements: 90,
      branches: 65,
      functions: 90,
      lines: 90,
    },
    "./src/lib/market-data-provider.ts": {
      statements: 88,
      branches: 75,
      functions: 88,
      lines: 88,
    },
    "./src/lib/admin-route-auth.ts": {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    "./src/lib/config.ts": {
      statements: 95,
      branches: 95,
      functions: 100,
      lines: 95,
    },
    "./src/trading/accounting.ts": {
      statements: 85,
      branches: 78,
      functions: 100,
      lines: 85,
    },
    "./src/trading/paper-execution.ts": {
      statements: 100,
      branches: 85,
      functions: 100,
      lines: 100,
    },
    "./src/trading/policy.ts": {
      statements: 90,
      branches: 85,
      functions: 100,
      lines: 90,
    },
  },
};

export default config;
