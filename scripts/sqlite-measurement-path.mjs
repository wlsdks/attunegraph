import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { types as nodeTypes } from "node:util";

function assertPathAbsent(path, label) {
  try {
    lstatSync(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    throw cause;
  }
  throw new Error(`${label} requires a new databasePath and sidecars`);
}

/** Strict package-owned admission shared by local SQLite measurement tools. */
export function parseNewSqliteMeasurementDatabasePath(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} requires one new canonical absolute databasePath`);
  }
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "databasePath");
  if (
    keys.length !== 1
    || keys[0] !== "databasePath"
    || descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
    || !isAbsolute(descriptor.value)
    || normalize(descriptor.value) !== descriptor.value
  ) {
    throw new Error(`${label} requires one new canonical absolute databasePath`);
  }
  const databasePath = descriptor.value;
  const parent = dirname(databasePath);
  let parentMetadata;
  try {
    parentMetadata = lstatSync(parent);
  } catch {
    throw new Error(`${label} database parent must be an existing canonical directory`);
  }
  if (
    !parentMetadata.isDirectory()
    || parentMetadata.isSymbolicLink()
    || realpathSync(parent) !== parent
  ) {
    throw new Error(`${label} database parent must be an existing canonical directory`);
  }
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    assertPathAbsent(path, label);
  }
  return databasePath;
}
