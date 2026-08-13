import {
  RUNTIME_ROLE_NAME,
  bootstrapRuntimeRoleMembership,
  bootstrapRuntimeLoginRole,
  isValidRoleIdentifier,
} from "@/deployment/bootstrap-runtime-role";
import postgres from "postgres";

jest.mock("postgres", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockedPostgres = jest.mocked(postgres);

function createSqlMock(
  scenario:
    | "grant"
    | "already-member"
    | "missing-runtime-role"
    | "runtime-role-can-login"
    | "missing-login-role" = "grant",
) {
  const granted: string[] = [];
  const sql = jest.fn(
    async (
      first: TemplateStringsArray | string,
      ..._values: unknown[]
    ): Promise<unknown> => {
      if (typeof first === "string") {
        return { identifier: first };
      }
      const query = Array.from(first).join(" ").replace(/\s+/g, " ").trim();
      if (query.includes("NOT rolcanlogin")) {
        if (scenario === "missing-runtime-role") {
          return [];
        }
        return [
          {
            present: true,
            isGroupRole: scenario !== "runtime-role-can-login",
          },
        ];
      }
      if (
        query.includes("FROM pg_roles") &&
        query.includes("rolname =")
      ) {
        if (scenario === "missing-login-role") {
          return [];
        }
        return [{ present: true }];
      }
      if (query.includes("pg_has_role")) {
        return [{ isMember: scenario === "already-member" }];
      }
      if (query.includes("GRANT")) {
        granted.push(query);
        return [];
      }
      throw new Error(`Unhandled SQL in test: ${query}`);
    },
  ) as jest.Mock & { end: jest.Mock; granted: string[] };
  sql.end = jest.fn(async () => undefined);
  sql.granted = granted;
  return sql;
}

describe("bootstrapRuntimeRoleMembership", () => {
  beforeEach(() => {
    mockedPostgres.mockReset();
  });

  it("validates role identifiers defensively", () => {
    expect(isValidRoleIdentifier("azure_app_identity")).toBe(true);
    expect(isValidRoleIdentifier("_leading_underscore")).toBe(true);
    expect(isValidRoleIdentifier("1_leading_digit")).toBe(false);
    expect(isValidRoleIdentifier("role; DROP TABLE x;")).toBe(false);
    expect(isValidRoleIdentifier("has space")).toBe(false);
    expect(isValidRoleIdentifier("a".repeat(64))).toBe(false);
  });

  it("throws when DIRECT_URL is missing", async () => {
    await expect(
      bootstrapRuntimeRoleMembership({ loginRole: "azure_app_identity" }),
    ).rejects.toThrow(/DIRECT_URL is required/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws when no login role is supplied", async () => {
    await expect(
      bootstrapRuntimeRoleMembership({
        directUrl: "******db.example.com/postgres",
      }),
    ).rejects.toThrow(/target Azure login role name is required/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws for a malformed or unsafe login role name", async () => {
    await expect(
      bootstrapRuntimeRoleMembership({
        directUrl: "******db.example.com/postgres",
        loginRole: "role; DROP TABLE x;",
      }),
    ).rejects.toThrow(/unsafe or malformed role name/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws when the krypto_runtime role does not exist", async () => {
    mockedPostgres.mockReturnValueOnce(
      createSqlMock("missing-runtime-role") as never,
    );

    await expect(
      bootstrapRuntimeRoleMembership({
        directUrl: "******db.example.com/postgres",
        loginRole: "azure_app_identity",
      }),
    ).rejects.toThrow(
      new RegExp(`Role ${RUNTIME_ROLE_NAME} does not exist`),
    );
  });

  it("throws when krypto_runtime unexpectedly permits LOGIN", async () => {
    mockedPostgres.mockReturnValueOnce(
      createSqlMock("runtime-role-can-login") as never,
    );

    await expect(
      bootstrapRuntimeRoleMembership({
        directUrl: "******db.example.com/postgres",
        loginRole: "azure_app_identity",
      }),
    ).rejects.toThrow(/unexpectedly permits LOGIN/);
  });

  it("throws when the target login role does not exist", async () => {
    mockedPostgres.mockReturnValueOnce(
      createSqlMock("missing-login-role") as never,
    );

    await expect(
      bootstrapRuntimeRoleMembership({
        directUrl: "******db.example.com/postgres",
        loginRole: "azure_app_identity",
      }),
    ).rejects.toThrow(/Login role azure_app_identity does not exist/);
  });

  it("grants membership when the login role is not yet a member", async () => {
    const sql = createSqlMock("grant");
    mockedPostgres.mockReturnValueOnce(sql as never);

    const result = await bootstrapRuntimeRoleMembership({
      directUrl: "******db.example.com/postgres",
      loginRole: "azure_app_identity",
    });

    expect(result).toEqual({
      runtimeRole: RUNTIME_ROLE_NAME,
      loginRole: "azure_app_identity",
      runtimeRolePresent: true,
      runtimeRoleIsGroupRole: true,
      loginRolePresent: true,
      alreadyMember: false,
      membershipGranted: true,
    });
    expect(sql.granted).toHaveLength(1);
    expect(sql.end).toHaveBeenCalled();
  });

  it("is idempotent when the login role is already a member", async () => {
    const sql = createSqlMock("already-member");
    mockedPostgres.mockReturnValueOnce(sql as never);

    const result = await bootstrapRuntimeRoleMembership({
      directUrl: "******db.example.com/postgres",
      loginRole: "azure_app_identity",
    });

    expect(result.alreadyMember).toBe(true);
    expect(result.membershipGranted).toBe(false);
    expect(sql.granted).toHaveLength(0);
    expect(sql.end).toHaveBeenCalled();
  });
});

function createLoginSqlMock(
  scenario:
    | "fresh-create"
    | "rotate-already-member"
    | "rotate-not-yet-member"
    | "missing-runtime-role"
    | "runtime-role-can-login"
    | "elevated-existing-role"
    | "verification-fails" = "fresh-create",
) {
  const executed: string[] = [];
  let loginRoleExistsNow = scenario.startsWith("rotate");
  const sql = jest.fn(
    async (
      first: TemplateStringsArray | string,
      ..._values: unknown[]
    ): Promise<unknown> => {
      if (typeof first === "string") {
        return { identifier: first };
      }
      const query = Array.from(first).join(" ").replace(/\s+/g, " ").trim();
      executed.push(query);

      if (query.includes("NOT rolcanlogin")) {
        if (scenario === "missing-runtime-role") {
          return [];
        }
        return [
          {
            present: true,
            isGroupRole: scenario !== "runtime-role-can-login",
          },
        ];
      }
      if (query.includes("rolsuper") && query.includes("canCreateDb") && !query.includes("canLogin")) {
        // Pre-existing-role attribute check (before create/rotate).
        if (scenario === "elevated-existing-role") {
          return [
            {
              present: true,
              isSuperuser: true,
              canCreateDb: false,
              canCreateRole: false,
              canReplicate: false,
              canBypassRls: false,
            },
          ];
        }
        if (scenario.startsWith("rotate")) {
          return [
            {
              present: true,
              isSuperuser: false,
              canCreateDb: false,
              canCreateRole: false,
              canReplicate: false,
              canBypassRls: false,
            },
          ];
        }
        return [];
      }
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") {
        return [];
      }
      if (query.includes("set_config")) {
        return [];
      }
      if (query.includes("DO $$")) {
        loginRoleExistsNow = true;
        return [];
      }
      if (query.includes("canLogin")) {
        // Post-bootstrap verification.
        if (scenario === "verification-fails") {
          return [
            {
              canLogin: false,
              isSuperuser: false,
              canCreateDb: false,
              canCreateRole: false,
              canReplicate: false,
              canBypassRls: false,
            },
          ];
        }
        return [
          {
            canLogin: true,
            isSuperuser: false,
            canCreateDb: false,
            canCreateRole: false,
            canReplicate: false,
            canBypassRls: false,
          },
        ];
      }
      if (query.includes("pg_has_role")) {
        return [{ isMember: scenario === "rotate-already-member" }];
      }
      if (query.includes("GRANT")) {
        return [];
      }
      throw new Error(`Unhandled SQL in test: ${query}`);
    },
  ) as jest.Mock & { end: jest.Mock; executed: string[] };
  sql.end = jest.fn(async () => undefined);
  sql.executed = executed;
  return sql;
}

describe("bootstrapRuntimeLoginRole", () => {
  beforeEach(() => {
    mockedPostgres.mockReset();
  });

  const baseInput = {
    directUrl: "******db.example.com/postgres",
    runtimeUrl: "postgresql://azure_app_identity@pooler.example.com/postgres",
    loginRole: "azure_app_identity",
    loginPassword: "s3cret-pass",
  };

  it("throws when DIRECT_URL is missing", async () => {
    await expect(
      bootstrapRuntimeLoginRole({ ...baseInput, directUrl: undefined }),
    ).rejects.toThrow(/DIRECT_URL is required/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws when DATABASE_URL is missing", async () => {
    await expect(
      bootstrapRuntimeLoginRole({ ...baseInput, runtimeUrl: undefined }),
    ).rejects.toThrow(/DATABASE_URL is required/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws when no login role is supplied", async () => {
    await expect(
      bootstrapRuntimeLoginRole({ ...baseInput, loginRole: undefined }),
    ).rejects.toThrow(/target Azure login role name is required/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws for a malformed or unsafe login role name", async () => {
    await expect(
      bootstrapRuntimeLoginRole({
        ...baseInput,
        loginRole: "role; DROP TABLE x;",
      }),
    ).rejects.toThrow(/unsafe or malformed role name/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws when no login password is supplied", async () => {
    await expect(
      bootstrapRuntimeLoginRole({ ...baseInput, loginPassword: undefined }),
    ).rejects.toThrow(/login password is required/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws when DATABASE_URL's username does not match the target login role", async () => {
    await expect(
      bootstrapRuntimeLoginRole({
        ...baseInput,
        runtimeUrl: "postgresql://someone_else@pooler.example.com/postgres",
      }),
    ).rejects.toThrow(/does not match the target login role/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws when DATABASE_URL is not a parseable URL", async () => {
    await expect(
      bootstrapRuntimeLoginRole({ ...baseInput, runtimeUrl: "not-a-url" }),
    ).rejects.toThrow(/DATABASE_URL is not a valid connection URL/);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("throws when the krypto_runtime role does not exist", async () => {
    mockedPostgres.mockReturnValueOnce(
      createLoginSqlMock("missing-runtime-role") as never,
    );

    await expect(bootstrapRuntimeLoginRole(baseInput)).rejects.toThrow(
      new RegExp(`Role ${RUNTIME_ROLE_NAME} does not exist`),
    );
  });

  it("throws when krypto_runtime unexpectedly permits LOGIN", async () => {
    mockedPostgres.mockReturnValueOnce(
      createLoginSqlMock("runtime-role-can-login") as never,
    );

    await expect(bootstrapRuntimeLoginRole(baseInput)).rejects.toThrow(
      /unexpectedly permits LOGIN/,
    );
  });

  it("refuses to touch a pre-existing role that already carries an elevated attribute", async () => {
    mockedPostgres.mockReturnValueOnce(
      createLoginSqlMock("elevated-existing-role") as never,
    );

    await expect(bootstrapRuntimeLoginRole(baseInput)).rejects.toThrow(
      /already exists with an elevated attribute/,
    );
  });

  it("creates a fresh login role, verifies safe attributes, and grants membership", async () => {
    const sql = createLoginSqlMock("fresh-create");
    mockedPostgres.mockReturnValueOnce(sql as never);

    const result = await bootstrapRuntimeLoginRole(baseInput);

    expect(result).toEqual({
      runtimeRole: RUNTIME_ROLE_NAME,
      loginRole: "azure_app_identity",
      runtimeRolePresent: true,
      runtimeRoleIsGroupRole: true,
      runtimeUrlUsernameMatched: true,
      loginRoleExisted: false,
      loginRoleCreated: true,
      passwordRotated: false,
      loginRoleAttributesSafe: true,
      alreadyMember: false,
      membershipGranted: true,
    });
    // The password must never appear in any executed query's text.
    expect(
      sql.executed.some((query) => query.includes("s3cret-pass")),
    ).toBe(false);
    expect(sql.end).toHaveBeenCalled();
  });

  it("rotates an existing safe login role's password and stays idempotent on membership", async () => {
    const sql = createLoginSqlMock("rotate-already-member");
    mockedPostgres.mockReturnValueOnce(sql as never);

    const result = await bootstrapRuntimeLoginRole(baseInput);

    expect(result.loginRoleExisted).toBe(true);
    expect(result.loginRoleCreated).toBe(false);
    expect(result.passwordRotated).toBe(true);
    expect(result.loginRoleAttributesSafe).toBe(true);
    expect(result.alreadyMember).toBe(true);
    expect(result.membershipGranted).toBe(false);
    expect(
      sql.executed.some((query) => query.includes("s3cret-pass")),
    ).toBe(false);
  });

  it("grants membership when rotating a role that was not yet a member", async () => {
    const sql = createLoginSqlMock("rotate-not-yet-member");
    mockedPostgres.mockReturnValueOnce(sql as never);

    const result = await bootstrapRuntimeLoginRole(baseInput);

    expect(result.alreadyMember).toBe(false);
    expect(result.membershipGranted).toBe(true);
  });

  it("throws when post-bootstrap verification finds unsafe attributes", async () => {
    mockedPostgres.mockReturnValueOnce(
      createLoginSqlMock("verification-fails") as never,
    );

    await expect(bootstrapRuntimeLoginRole(baseInput)).rejects.toThrow(
      /Post-bootstrap verification failed/,
    );
  });
});
