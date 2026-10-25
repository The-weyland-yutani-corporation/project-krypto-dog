import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("Azure Identity dependency compatibility", () => {
  it("loads the real credential chain and patched CommonJS UUID without requesting a token", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { createRequire } from "node:module";
          import {
            DefaultAzureCredential,
            ManagedIdentityCredential,
            getBearerTokenProvider,
          } from "@azure/identity";

          const require = createRequire(import.meta.url);
          const fromIdentity = createRequire(require.resolve("@azure/identity"));
          const { CryptoProvider } = fromIdentity("@azure/msal-node");
          const fromMsal = createRequire(fromIdentity.resolve("@azure/msal-node"));
          const { v5, validate, version } = fromMsal("uuid");
          const id = new CryptoProvider().createNewGuid();
          assert.equal(validate(id), true);
          assert.equal(version(id), 4);
          assert.throws(() => v5("x", v5.DNS, new Uint8Array(8), 4), RangeError);

          const managed = new ManagedIdentityCredential("11111111-1111-4111-8111-111111111111");
          assert.equal(typeof managed.getToken, "function");
          assert.equal(typeof new DefaultAzureCredential().getToken, "function");
          assert.equal(
            typeof getBearerTokenProvider(managed, "https://cognitiveservices.azure.com/.default"),
            "function",
          );
          console.log("credential-chain-compatible");
        `,
      ],
      {
        cwd: resolve(__dirname, "..", ".."),
        encoding: "utf8",
        timeout: 15_000,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
        },
      },
    );
    expect(output.trim()).toBe("credential-chain-compatible");
  });
});
