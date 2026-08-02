import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
import { runV4StorageCostBenchmark } from "./benchmark-attunegraph-current-head-materialization.mjs";

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  try {
    runV4StorageCostBenchmark(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
