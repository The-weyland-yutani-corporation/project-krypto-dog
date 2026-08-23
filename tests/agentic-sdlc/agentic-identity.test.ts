export {};

interface IdentityModule {
  resolveRepositoryCopilotIdentity(input: {
    github: { graphql: jest.Mock };
    owner: string;
    repo: string;
  }): Promise<{
    nodeId: string;
    databaseId: number;
    suggestedLogin: string;
  }>;
  isResolvedCopilotActor(
    actor: unknown,
    identity: { nodeId: string; databaseId: number },
  ): boolean;
  isConfiguredAssignmentActor(actor: unknown, nodeId: string): boolean;
  normalizeConfiguredUserNodeId(value: unknown): string;
}

const identity = jest.requireActual<IdentityModule>(
  "../../.github/scripts/agentic-identity.cjs",
);

function page(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    repository: {
      suggestedActors: {
        nodes,
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

const copilot = {
  __typename: "Bot",
  login: "copilot-swe-agent",
  id: "BOT_stable",
  databaseId: 198982749,
};

describe("canonical Copilot identity", () => {
  it("fully paginates and resolves exactly one stable Copilot Bot", async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce(
        page([{ __typename: "User", login: "owner", id: "U_owner", databaseId: 1 }], true, "next"),
      )
      .mockResolvedValueOnce(page([copilot]));

    await expect(
      identity.resolveRepositoryCopilotIdentity({
        github: { graphql },
        owner: "org",
        repo: "repo",
      }),
    ).resolves.toEqual({
      nodeId: "BOT_stable",
      databaseId: 198982749,
      suggestedLogin: "copilot-swe-agent",
    });
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1]).toMatchObject({ after: "next" });
  });

  it.each([
    ["missing", []],
    ["duplicate", [copilot, { ...copilot, id: "BOT_other", databaseId: 2 }]],
    [
      "wrong type",
      [{ ...copilot, __typename: "User", id: "U_wrong", databaseId: 3 }],
    ],
    [
      "missing stable ID",
      [{ __typename: "Bot", login: "copilot-swe-agent" }],
    ],
  ])("fails closed for a %s suggested actor result", async (_name, nodes) => {
    const graphql = jest.fn().mockResolvedValue(page(nodes));
    await expect(
      identity.resolveRepositoryCopilotIdentity({
        github: { graphql },
        owner: "org",
        repo: "repo",
      }),
    ).rejects.toThrow();
  });

  it("fails closed when pagination omits its cursor", async () => {
    const graphql = jest.fn().mockResolvedValue(page([], true, null));
    await expect(
      identity.resolveRepositoryCopilotIdentity({
        github: { graphql },
        owner: "org",
        repo: "repo",
      }),
    ).rejects.toThrow("pagination cursor");
  });

  it("matches REST actors by Bot type plus both stable IDs, not login", () => {
    const resolved = { nodeId: "BOT_stable", databaseId: 198982749 };
    expect(
      identity.isResolvedCopilotActor(
        {
          login: "Copilot",
          type: "Bot",
          id: 198982749,
          node_id: "BOT_stable",
        },
        resolved,
      ),
    ).toBe(true);
    expect(
      identity.isResolvedCopilotActor(
        {
          login: "Copilot",
          type: "Bot",
          id: 999,
          node_id: "BOT_stable",
        },
        resolved,
      ),
    ).toBe(false);
    expect(
      identity.isResolvedCopilotActor(
        {
          login: "copilot-swe-agent",
          type: "User",
          id: 198982749,
          node_id: "BOT_stable",
        },
        resolved,
      ),
    ).toBe(false);
  });

  it("requires the configured assignment actor to be the exact User node ID", () => {
    expect(
      identity.isConfiguredAssignmentActor(
        { login: "owner", type: "User", node_id: "U_owner" },
        "U_owner",
      ),
    ).toBe(true);
    expect(
      identity.isConfiguredAssignmentActor(
        { login: "owner", type: "Bot", node_id: "U_owner" },
        "U_owner",
      ),
    ).toBe(false);
    expect(() => identity.normalizeConfiguredUserNodeId("")).toThrow();
    expect(identity.normalizeConfiguredUserNodeId("U_owner")).toBe("U_owner");
  });
});
