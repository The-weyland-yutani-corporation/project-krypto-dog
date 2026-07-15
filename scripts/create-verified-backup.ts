import { createVerifiedBackup } from "@/deployment/backup";

type Arguments = {
  out: string;
  restoreTestUrl?: string;
};

function parseArguments(argv: string[]): Arguments {
  let out: string | undefined;
  let restoreTestUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (
      (argument === "--out" || argument === "--restore-test-url") &&
      (!value || value.startsWith("--"))
    ) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--out") {
      out = value;
      index += 1;
    } else if (argument === "--restore-test-url") {
      restoreTestUrl = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!out) {
    throw new Error("--out <directory> is required.");
  }
  return { out, restoreTestUrl };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DIRECT_URL;
  const runtimeDatabaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DIRECT_URL is required.");
  }
  if (!runtimeDatabaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  const arguments_ = parseArguments(process.argv.slice(2));
  const manifest = await createVerifiedBackup({
    databaseUrl,
    runtimeDatabaseUrl,
    outputDirectory: arguments_.out,
    restoreTestUrl: arguments_.restoreTestUrl,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Backup verification failed: ${message}\n`);
  process.exitCode = 1;
});
