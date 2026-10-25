const { createHash } = require("node:crypto");

function deploymentFenceOwner(repositoryId, runId) {
  if (![repositoryId, runId].every((id) => typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id))) {
    throw new Error("Fence ownership requires positive repository and workflow run IDs.");
  }
  const namespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const name = `project-krypto/production-cutover/${repositoryId}/${runId}`;
  const bytes = createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { deploymentFenceOwner };
if (require.main === module) {
  try {
    process.stdout.write(deploymentFenceOwner(process.argv[2], process.argv[3]));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
