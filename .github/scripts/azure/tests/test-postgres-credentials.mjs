import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync(
  process.argv[2] ?? new URL("../../../../infra/environment.json", import.meta.url),
  "utf8",
));
assert.deepEqual(template.parameters.postgresCredentialMode.allowedValues, ["initialize", "preserve"]);
assert.equal(template.parameters.postgresCredentialMode.defaultValue, "initialize");
assert.equal(template.parameters.postgresAdministratorLoginPassword.type.toLowerCase(), "securestring");
assert.equal(template.parameters.postgresAdministratorLoginPassword.defaultValue, undefined);

const postgresModule = template.resources.find((resource) => resource.name === "postgres");
assert(postgresModule, "The complete environment must still deploy PostgreSQL infrastructure.");
assert.equal(
  postgresModule.properties.parameters.preserveAdministratorPassword.value,
  "[equals(parameters('postgresCredentialMode'), 'preserve')]",
);
const server = postgresModule.properties.template.resources.find(
  (resource) => resource.type === "Microsoft.DBforPostgreSQL/flexibleServers",
);
assert(server, "The PostgreSQL server must remain managed by the environment template.");
assert.equal(server.apiVersion, "2024-08-01");
assert.equal(postgresModule.properties.template.parameters.preserveAdministratorPassword.defaultValue, false);
assert.equal(typeof server.properties, "string");
assert(server.properties.startsWith(
  "[union(createObject('createMode', if(parameters('preserveAdministratorPassword'), 'Update', 'Default'), ",
));
assert(server.properties.endsWith(
  ", if(parameters('preserveAdministratorPassword'), createObject(), createObject('administratorLoginPassword', parameters('administratorLoginPassword'))))]",
), "Preserve mode must omit the password property, not submit null or a different credential.");
assert.equal(
  server.properties.match(/administratorLoginPassword/g)?.length,
  2,
  "The password property and parameter may occur only in the initialize branch.",
);
console.log("Compiled PostgreSQL credential contract passed: initialize is explicit; existing-release updates omit the password.");
