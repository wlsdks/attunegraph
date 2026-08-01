import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectEntrypoint(
  importMetaUrl,
  argvPath,
  canonicalize = realpathSync
) {
  if (typeof argvPath !== "string") return false;
  try {
    return canonicalize(resolve(argvPath)) === canonicalize(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
