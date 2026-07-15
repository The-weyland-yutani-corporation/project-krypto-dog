import {
  isLoopbackHostname,
  passwordlessPostgresUrl,
  scrubPostgresEnvironment,
} from "@/deployment/backup";

describe("deployment backup helpers", () => {
  it("removes passwords without discarding connection options", () => {
    const result = passwordlessPostgresUrl(
      "postgresql://operator:secret@example.supabase.co:5432/postgres?sslmode=require",
    );

    expect(result).not.toContain("secret");
    expect(result).toContain("operator@example.supabase.co:5432/postgres");
    expect(result).toContain("sslmode=require");
  });

  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])(
    "accepts loopback restore host %s",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(true);
    },
  );

  it("rejects remote restore hosts", () => {
    expect(isLoopbackHostname("db.example.com")).toBe(false);
  });

  it.each([
    "database",
    "dbname",
    "host",
    "hostaddr",
    "passfile",
    "password",
    "port",
    "service",
    "servicefile",
    "sslpassword",
    "user",
  ])(
    "rejects connection-identity override parameter %s",
    (parameter) => {
      expect(() =>
        passwordlessPostgresUrl(
          `postgresql://operator:secret@127.0.0.1/postgres?${parameter}=unsafe`,
        ),
      ).toThrow("is not allowed");
    },
  );

  it("scrubs all inherited PostgreSQL client settings", () => {
    expect(
      scrubPostgresEnvironment({
        HOME: "/tmp/home",
        PGHOST: "wrong-host",
        PGOPTIONS: "-c search_path=unsafe",
        PGREQUIREAUTH: "none",
      }),
    ).toEqual({ HOME: "/tmp/home" });
  });
});
