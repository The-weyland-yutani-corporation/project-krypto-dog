import nextConfig from "eslint-config-next";

const config = [
  ...nextConfig,
  {
    ignores: ["coverage/**"],
  },
  {
    files: ["src/agent/{decision,llm}.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/trading/paper-executor",
                "@/trading/paper-execution",
                "../trading/paper-executor",
                "../trading/paper-execution",
              ],
              message:
                "Decision/model modules are read-only. Route proposals through run-flow and deterministic trading authorization; never import execution here.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/trading/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/agent/**", "../agent/**", "@langchain/**"],
              message:
                "Deterministic trading policy and execution must not depend on agent/model modules. Pass validated proposal data across the boundary instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/components/**/*.{ts,tsx}",
      "src/app/**/_components/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db", "@/db/**"],
              message:
                "Shared/client UI components must receive typed data from a server component or API boundary; do not import the database implementation.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
