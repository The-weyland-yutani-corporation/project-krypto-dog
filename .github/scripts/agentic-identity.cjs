"use strict";

const { AGENTIC_POLICY } = require("./agentic-policy.cjs");

const GRAPHQL_FEATURES =
  "issues_copilot_assignment_api_support,coding_agent_model_selection";
const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]";
const MAX_SUGGESTED_ACTOR_PAGES = 100;

const SUGGESTED_ACTORS_QUERY = `
  query ResolveCopilotSuggestedActor(
    $owner: String!
    $repo: String!
    $after: String
  ) {
    repository(owner: $owner, name: $repo) {
      suggestedActors(
        capabilities: [CAN_BE_ASSIGNED]
        first: 100
        after: $after
      ) {
        nodes {
          __typename
          login
          ... on Bot {
            id
            databaseId
          }
          ... on User {
            id
            databaseId
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

class AgenticIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgenticIdentityError";
    this.code = code;
  }
}

function actorType(actor) {
  if (!actor || typeof actor !== "object") {
    return undefined;
  }
  return actor.type || actor.__typename;
}

function actorNodeId(actor) {
  if (!actor || typeof actor !== "object") {
    return undefined;
  }
  if (typeof actor.node_id === "string" && actor.node_id.trim() !== "") {
    return actor.node_id;
  }
  if (typeof actor.id === "string" && actor.id.trim() !== "") {
    return actor.id;
  }
  return undefined;
}

function actorDatabaseId(actor) {
  if (!actor || typeof actor !== "object") {
    return undefined;
  }
  if (Number.isInteger(actor.databaseId) && actor.databaseId > 0) {
    return actor.databaseId;
  }
  if (Number.isInteger(actor.id) && actor.id > 0) {
    return actor.id;
  }
  return undefined;
}

function normalizeConfiguredUserNodeId(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    /\s/.test(value) ||
    value.length > 200
  ) {
    throw new AgenticIdentityError(
      "invalid-assignment-actor-node-id",
      "FACTORY_ASSIGNMENT_ACTOR_NODE_ID must be one non-empty stable User node ID",
    );
  }
  return value.trim();
}

function normalizeResolvedCopilotActor(actor, expectedLogin) {
  if (actorType(actor) !== "Bot" || actor.login !== expectedLogin) {
    throw new AgenticIdentityError(
      "invalid-copilot-suggested-actor",
      "The resolved Copilot suggested actor must be the expected Bot",
    );
  }
  const nodeId = actorNodeId(actor);
  const databaseId = actorDatabaseId(actor);
  if (!nodeId || !databaseId) {
    throw new AgenticIdentityError(
      "malformed-copilot-suggested-actor",
      "The resolved Copilot suggested actor lacks stable IDs",
    );
  }
  return Object.freeze({
    nodeId,
    databaseId,
    suggestedLogin: expectedLogin,
  });
}

async function resolveRepositoryCopilotIdentity({
  github,
  owner,
  repo,
  suggestedActorLogin = AGENTIC_POLICY.copilotSuggestedActorLogin,
}) {
  if (!github || typeof github.graphql !== "function") {
    throw new AgenticIdentityError(
      "copilot-identity-api-unavailable",
      "GitHub GraphQL is unavailable for Copilot identity resolution",
    );
  }

  const matches = [];
  let after = null;
  let page = 0;
  do {
    page += 1;
    if (page > MAX_SUGGESTED_ACTOR_PAGES) {
      throw new AgenticIdentityError(
        "copilot-identity-pagination-overflow",
        "Copilot identity resolution exceeded the pagination bound",
      );
    }

    let response;
    try {
      response = await github.graphql(SUGGESTED_ACTORS_QUERY, {
        owner,
        repo,
        after,
        headers: {
          "GraphQL-Features": GRAPHQL_FEATURES,
        },
      });
    } catch (error) {
      throw new AgenticIdentityError(
        "copilot-identity-lookup-failed",
        `Could not resolve the repository Copilot actor: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const connection = response?.repository?.suggestedActors;
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !connection.pageInfo ||
      typeof connection.pageInfo.hasNextPage !== "boolean"
    ) {
      throw new AgenticIdentityError(
        "copilot-identity-response-malformed",
        "Copilot identity lookup returned an incomplete suggestedActors connection",
      );
    }

    for (const actor of connection.nodes) {
      if (actor && actor.login === suggestedActorLogin) {
        matches.push(actor);
      }
    }

    if (!connection.pageInfo.hasNextPage) {
      after = null;
      break;
    }
    if (
      typeof connection.pageInfo.endCursor !== "string" ||
      connection.pageInfo.endCursor === ""
    ) {
      throw new AgenticIdentityError(
        "copilot-identity-pagination-malformed",
        "Copilot identity lookup omitted a required pagination cursor",
      );
    }
    after = connection.pageInfo.endCursor;
  } while (after);

  if (matches.length !== 1) {
    throw new AgenticIdentityError(
      "copilot-identity-not-unique",
      `Expected exactly one ${suggestedActorLogin} Bot; found ${matches.length}`,
    );
  }
  return normalizeResolvedCopilotActor(matches[0], suggestedActorLogin);
}

function isResolvedCopilotActor(actor, identity) {
  return Boolean(
    identity &&
      actorType(actor) === "Bot" &&
      actorNodeId(actor) === identity.nodeId &&
      actorDatabaseId(actor) === identity.databaseId,
  );
}

function isConfiguredAssignmentActor(actor, configuredNodeId) {
  return Boolean(
    actorType(actor) === "User" &&
      actorNodeId(actor) === configuredNodeId,
  );
}

function isGitHubActionsBot(actor) {
  return Boolean(
    actorType(actor) === "Bot" &&
      actor.login === GITHUB_ACTIONS_BOT_LOGIN,
  );
}

module.exports = {
  AgenticIdentityError,
  GITHUB_ACTIONS_BOT_LOGIN,
  GRAPHQL_FEATURES,
  SUGGESTED_ACTORS_QUERY,
  actorDatabaseId,
  actorNodeId,
  actorType,
  isConfiguredAssignmentActor,
  isGitHubActionsBot,
  isResolvedCopilotActor,
  normalizeConfiguredUserNodeId,
  resolveRepositoryCopilotIdentity,
};
