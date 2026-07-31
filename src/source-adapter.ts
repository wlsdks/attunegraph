import { types as nodeTypes } from "node:util";

import type {
  AttuneGraph,
  AttuneGraphSnapshot,
  AttuneGraphSourceAdapter as OpaqueAttuneGraphSourceAdapter,
  AttuneGraphSourceFreshness,
  AttuneGraphSourceObservationV2,
  AttuneGraphScope
} from "./attunegraph-contracts.js";
import { AttuneGraphDataError } from "./error.js";
import type { GraphAssertion, GraphRef } from "./types.js";
import { normalizeGraphAssertionBatch } from "./validation.js";

export const MAX_SOURCE_ADAPTER_KINDS = 16;
export const MAX_SOURCE_ADAPTER_ASSERTIONS = 1_024;
export const MAX_SOURCE_ADAPTER_CORRELATION_KEY_CHARACTERS = 192;

const MAX_ADAPTER_ID_CHARACTERS = 128;
const MAX_ADAPTER_LABEL_CHARACTERS = 128;
const MAX_ADAPTER_VERSION_CHARACTERS = 64;
const MAX_OBSERVATION_KEY_CHARACTERS = 512;
const MAX_SOURCE_KIND_CHARACTERS = 64;
const MAX_GRAPH_ID_CHARACTERS = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const ADAPTER_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
declare const sourceAdapterInputBrand: unique symbol;

export type AttuneGraphSourceAdapterErrorCode =
  | "EXTRACTION_FAILED"
  | "INVALID_ADAPTER"
  | "INVALID_DEFINITION"
  | "INVALID_EXTRACTION"
  | "INVALID_INPUT";

export class AttuneGraphSourceAdapterError extends Error {
  readonly code: AttuneGraphSourceAdapterErrorCode;

  constructor(
    code: AttuneGraphSourceAdapterErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AttuneGraphSourceAdapterError";
    this.code = code;
  }
}

export interface AttuneGraphSourceAdapterMetadata {
  readonly id: string;
  readonly label: string;
  readonly version: string;
}

export interface AttuneGraphSourceAdapterCapabilities<
  SourceKind extends string = string
> {
  readonly maxAssertionsPerExtraction: number;
  readonly sourceKinds: readonly SourceKind[];
  readonly supportsIncremental: boolean;
}

export interface AttuneGraphSourceExtractionContext<
  SourceKind extends string = string
> {
  readonly adapter: AttuneGraphSourceAdapterMetadata;
  readonly observedAt: string;
  readonly scope: AttuneGraphScope;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly sourceKind: SourceKind;
  readonly threadRoot: GraphRef;
}

export interface AttuneGraphSourceExtraction {
  readonly assertions: readonly GraphAssertion[];
}

export interface AttuneGraphSourceAdapter<
  Input,
  SourceKind extends string = string
> extends OpaqueAttuneGraphSourceAdapter {
  readonly capabilities: AttuneGraphSourceAdapterCapabilities<SourceKind>;
  readonly metadata: AttuneGraphSourceAdapterMetadata;
  /** Type-only input witness. Host-owned extraction values are never retained. */
  readonly [sourceAdapterInputBrand]: Input;
}

export interface DefineAttuneGraphSourceAdapterOptions<
  Input,
  SourceKinds extends readonly string[]
> {
  readonly capabilities: {
    readonly maxAssertionsPerExtraction: number;
    readonly sourceKinds: SourceKinds;
    readonly supportsIncremental: boolean;
  };
  readonly extract: (
    input: Input,
    context: AttuneGraphSourceExtractionContext<SourceKinds[number]>
  ) => AttuneGraphSourceExtraction | Promise<AttuneGraphSourceExtraction>;
  readonly metadata: AttuneGraphSourceAdapterMetadata;
}

export interface BuildAttuneGraphSourceObservationOptions<
  Input,
  SourceKind extends string
> {
  readonly adapter: AttuneGraphSourceAdapter<Input, SourceKind>;
  /** Bounded host correlation key; the SDK namespaces it by adapter and kind. */
  readonly correlationKey: string;
  /** Host-owned value passed through once to the registered adapter. */
  readonly input: Input;
  readonly observedAt: string;
  readonly scope: AttuneGraphScope;
  /** Caller-declared source posture; the SDK does not independently verify it. */
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly sourceKind: SourceKind;
  readonly threadRoot: GraphRef;
}

export interface ProjectAttuneGraphSourceOptions<
  Input,
  SourceKind extends string
> extends BuildAttuneGraphSourceObservationOptions<Input, SourceKind> {
  readonly attuneGraph: AttuneGraph;
}

export interface AttuneGraphSourceProjectionResult {
  readonly observation: AttuneGraphSourceObservationV2;
  readonly snapshot: AttuneGraphSnapshot;
}

interface DataRecord {
  readonly descriptors: PropertyDescriptorMap;
  readonly keys: readonly string[];
}

interface RegisteredAdapter {
  readonly extract: (
    input: unknown,
    context: AttuneGraphSourceExtractionContext
  ) => AttuneGraphSourceExtraction | Promise<AttuneGraphSourceExtraction>;
}

interface NormalizedBuildInput {
  readonly adapter: AttuneGraphSourceAdapter<unknown>;
  readonly attuneGraph: unknown;
  readonly correlationKey: string;
  readonly extractionInput: unknown;
  readonly observedAt: string;
  readonly scope: AttuneGraphScope;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly sourceKind: string;
  readonly threadRoot: GraphRef;
}

const registeredAdapters = new WeakMap<object, RegisteredAdapter>();

function adapterError(
  code: AttuneGraphSourceAdapterErrorCode,
  message: string,
  options?: ErrorOptions
): never {
  throw new AttuneGraphSourceAdapterError(code, message, options);
}

function dataRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  code: AttuneGraphSourceAdapterErrorCode
): DataRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    adapterError(code, `${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    adapterError(code, `${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    adapterError(code, `${label} must not contain symbol fields`);
  }
  const keys = ownKeys as string[];
  if (keys.some((key) => !allowedKeys.includes(key))) {
    adapterError(code, `${label} contains unknown fields`);
  }
  if (requiredKeys.some((key) => !keys.includes(key))) {
    adapterError(code, `${label} is missing required fields`);
  }
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(
    value as object
  );
  if (keys.some((key) => !descriptors[key] || !("value" in descriptors[key]))) {
    adapterError(code, `${label} fields must be data properties`);
  }
  return { descriptors, keys };
}

function dataValue(record: DataRecord, key: string): unknown {
  return record.descriptors[key]?.value;
}

function safeText(
  value: unknown,
  label: string,
  maxCharacters: number,
  code: AttuneGraphSourceAdapterErrorCode
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > maxCharacters
    || CONTROL_CHARACTERS.test(value)
  ) {
    adapterError(
      code,
      `${label} must be non-empty, trimmed, bounded text without control characters`
    );
  }
  return value;
}

function canonicalInstant(
  value: unknown,
  label: string,
  code: AttuneGraphSourceAdapterErrorCode
): string {
  if (typeof value !== "string") {
    adapterError(code, `${label} must be a canonical ISO instant`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    adapterError(code, `${label} must be a canonical ISO instant`);
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  code: AttuneGraphSourceAdapterErrorCode
): readonly string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    adapterError(code, `${label} must be a non-proxy plain array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    adapterError(code, `${label} must be a plain array`);
  }
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(
    value as object
  );
  const length = descriptors["length"]?.value;
  if (
    !Number.isSafeInteger(length)
    || (length as number) < 1
    || (length as number) > MAX_SOURCE_ADAPTER_KINDS
  ) {
    adapterError(code, `${label} must contain 1-${MAX_SOURCE_ADAPTER_KINDS.toString()} items`);
  }
  const allowed = new Set(["length"]);
  const result: string[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const key = index.toString();
    allowed.add(key);
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      adapterError(code, `${label} must be dense and contain data properties`);
    }
    result.push(safeText(
      descriptor.value,
      `${label}[${key}]`,
      MAX_SOURCE_KIND_CHARACTERS,
      code
    ));
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    adapterError(code, `${label} must not contain extra fields`);
  }
  if (new Set(result).size !== result.length) {
    adapterError(code, `${label} must not contain duplicates`);
  }
  return Object.freeze(result);
}

function normalizeMetadata(value: unknown): AttuneGraphSourceAdapterMetadata {
  const record = dataRecord(
    value,
    "source adapter metadata",
    ["id", "label", "version"],
    ["id", "label", "version"],
    "INVALID_DEFINITION"
  );
  const id = safeText(
    dataValue(record, "id"),
    "source adapter metadata.id",
    MAX_ADAPTER_ID_CHARACTERS,
    "INVALID_DEFINITION"
  );
  if (!ADAPTER_ID.test(id)) {
    adapterError(
      "INVALID_DEFINITION",
      "source adapter metadata.id must be a lowercase dotted identifier"
    );
  }
  return Object.freeze({
    id,
    label: safeText(
      dataValue(record, "label"),
      "source adapter metadata.label",
      MAX_ADAPTER_LABEL_CHARACTERS,
      "INVALID_DEFINITION"
    ),
    version: safeText(
      dataValue(record, "version"),
      "source adapter metadata.version",
      MAX_ADAPTER_VERSION_CHARACTERS,
      "INVALID_DEFINITION"
    )
  });
}

function normalizeCapabilities(
  value: unknown
): AttuneGraphSourceAdapterCapabilities {
  const record = dataRecord(
    value,
    "source adapter capabilities",
    ["maxAssertionsPerExtraction", "sourceKinds", "supportsIncremental"],
    ["maxAssertionsPerExtraction", "sourceKinds", "supportsIncremental"],
    "INVALID_DEFINITION"
  );
  const maxAssertions = dataValue(record, "maxAssertionsPerExtraction");
  if (
    !Number.isSafeInteger(maxAssertions)
    || (maxAssertions as number) < 1
    || (maxAssertions as number) > MAX_SOURCE_ADAPTER_ASSERTIONS
  ) {
    adapterError(
      "INVALID_DEFINITION",
      `source adapter maxAssertionsPerExtraction must be an integer from 1-${MAX_SOURCE_ADAPTER_ASSERTIONS.toString()}`
    );
  }
  const supportsIncremental = dataValue(record, "supportsIncremental");
  if (typeof supportsIncremental !== "boolean") {
    adapterError(
      "INVALID_DEFINITION",
      "source adapter supportsIncremental must be boolean"
    );
  }
  return Object.freeze({
    maxAssertionsPerExtraction: maxAssertions as number,
    sourceKinds: stringArray(
      dataValue(record, "sourceKinds"),
      "source adapter capabilities.sourceKinds",
      "INVALID_DEFINITION"
    ),
    supportsIncremental
  });
}

function normalizeScope(value: unknown): AttuneGraphScope {
  const record = dataRecord(
    value,
    "source projection scope",
    ["sourceId", "threadId"],
    ["sourceId", "threadId"],
    "INVALID_INPUT"
  );
  return Object.freeze({
    sourceId: safeText(
      dataValue(record, "sourceId"),
      "source projection scope.sourceId",
      MAX_GRAPH_ID_CHARACTERS,
      "INVALID_INPUT"
    ),
    threadId: safeText(
      dataValue(record, "threadId"),
      "source projection scope.threadId",
      MAX_GRAPH_ID_CHARACTERS,
      "INVALID_INPUT"
    )
  });
}

function normalizeGraphRef(value: unknown): GraphRef {
  const record = dataRecord(
    value,
    "source projection threadRoot",
    ["id", "kind"],
    ["id", "kind"],
    "INVALID_INPUT"
  );
  const kind = dataValue(record, "kind");
  if (kind !== "thread") {
    adapterError("INVALID_INPUT", "source projection threadRoot.kind must be thread");
  }
  return Object.freeze({
    id: safeText(
      dataValue(record, "id"),
      "source projection threadRoot.id",
      MAX_GRAPH_ID_CHARACTERS,
      "INVALID_INPUT"
    ),
    kind
  });
}

function normalizeFreshness(value: unknown): AttuneGraphSourceFreshness {
  const record = dataRecord(
    value,
    "source projection freshness",
    ["state", "observedAt"],
    ["state", "observedAt"],
    "INVALID_INPUT"
  );
  const state = dataValue(record, "state");
  if (state !== "fresh" && state !== "stale" && state !== "unknown") {
    adapterError("INVALID_INPUT", "source projection freshness.state is invalid");
  }
  return Object.freeze({
    observedAt: canonicalInstant(
      dataValue(record, "observedAt"),
      "source projection freshness.observedAt",
      "INVALID_INPUT"
    ),
    state
  });
}

function dataMethod<T extends (...args: never[]) => unknown>(
  value: unknown,
  name: string
): T {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    adapterError("INVALID_INPUT", "attuneGraph must be a non-proxy object");
  }
  let cursor: object | null = value;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      adapterError("INVALID_INPUT", "attuneGraph prototype must not be a proxy");
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor) {
      if (
        !("value" in descriptor)
        || typeof descriptor.value !== "function"
        || nodeTypes.isProxy(descriptor.value)
      ) {
        adapterError("INVALID_INPUT", `attuneGraph.${name} must be a data method`);
      }
      return descriptor.value.bind(value) as T;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  adapterError("INVALID_INPUT", `attuneGraph is missing ${name}`);
}

function normalizeBuildInput(
  value: unknown,
  allowedKeys: readonly string[]
): NormalizedBuildInput {
  const record = dataRecord(
    value,
    "source projection input",
    allowedKeys,
    allowedKeys,
    "INVALID_INPUT"
  );
  const adapter = dataValue(record, "adapter");
  if (
    typeof adapter !== "object"
    || adapter === null
    || nodeTypes.isProxy(adapter)
    || !registeredAdapters.has(adapter)
  ) {
    adapterError(
      "INVALID_ADAPTER",
      "source adapter must be created by defineAttuneGraphSourceAdapter"
    );
  }
  const typedAdapter = adapter as AttuneGraphSourceAdapter<unknown>;
  const sourceKind = safeText(
    dataValue(record, "sourceKind"),
    "source projection sourceKind",
    MAX_SOURCE_KIND_CHARACTERS,
    "INVALID_INPUT"
  );
  if (!typedAdapter.capabilities.sourceKinds.includes(sourceKind)) {
    adapterError("INVALID_INPUT", "source projection sourceKind is not supported by the adapter");
  }
  return {
    adapter: typedAdapter,
    attuneGraph: dataValue(record, "attuneGraph"),
    correlationKey: safeText(
      dataValue(record, "correlationKey"),
      "source projection correlationKey",
      MAX_SOURCE_ADAPTER_CORRELATION_KEY_CHARACTERS,
      "INVALID_INPUT"
    ),
    extractionInput: dataValue(record, "input"),
    observedAt: canonicalInstant(
      dataValue(record, "observedAt"),
      "source projection observedAt",
      "INVALID_INPUT"
    ),
    scope: normalizeScope(dataValue(record, "scope")),
    sourceFreshness: normalizeFreshness(dataValue(record, "sourceFreshness")),
    sourceKind,
    threadRoot: normalizeGraphRef(dataValue(record, "threadRoot"))
  };
}

function normalizeExtraction(
  value: unknown,
  maxAssertions: number
): readonly GraphAssertion[] {
  const record = dataRecord(
    value,
    "source adapter extraction",
    ["assertions"],
    ["assertions"],
    "INVALID_EXTRACTION"
  );
  const assertions = dataValue(record, "assertions");
  if (!Array.isArray(assertions) || nodeTypes.isProxy(assertions)) {
    adapterError(
      "INVALID_EXTRACTION",
      "source adapter extraction.assertions must be a non-proxy plain array"
    );
  }
  const length = Object.getOwnPropertyDescriptor(assertions, "length")?.value;
  if (!Number.isSafeInteger(length) || (length as number) > maxAssertions) {
    adapterError(
      "INVALID_EXTRACTION",
      "source adapter extraction exceeds its declared assertion limit"
    );
  }
  try {
    return normalizeGraphAssertionBatch(assertions).map((assertion) => ({
      derivation: { ...assertion.derivation },
      epistemicClass: assertion.epistemicClass,
      id: assertion.id,
      object: { ...assertion.object },
      predicate: assertion.predicate,
      recordedAt: assertion.recordedAt,
      schemaVersion: 1,
      sourceRefs: assertion.sourceRefs.map((sourceRef) => ({ ...sourceRef })),
      subject: { ...assertion.subject },
      ...(assertion.supersededAt
        ? { supersededAt: assertion.supersededAt }
        : {}),
      ...(assertion.validFrom ? { validFrom: assertion.validFrom } : {}),
      ...(assertion.validTo ? { validTo: assertion.validTo } : {})
    }));
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError) {
      adapterError(
        "INVALID_EXTRACTION",
        "source adapter emitted invalid assertions",
        { cause }
      );
    }
    throw cause;
  }
}

async function extractObservation(
  input: NormalizedBuildInput
): Promise<AttuneGraphSourceObservationV2> {
  const registered = registeredAdapters.get(input.adapter as object);
  if (!registered) {
    adapterError("INVALID_ADAPTER", "source adapter registration is unavailable");
  }
  const context: AttuneGraphSourceExtractionContext = Object.freeze({
    adapter: input.adapter.metadata,
    observedAt: input.observedAt,
    scope: input.scope,
    sourceFreshness: input.sourceFreshness,
    sourceKind: input.sourceKind,
    threadRoot: input.threadRoot
  });
  let extraction: AttuneGraphSourceExtraction;
  try {
    extraction = await registered.extract(input.extractionInput, context);
  } catch (cause) {
    if (cause instanceof AttuneGraphSourceAdapterError) throw cause;
    throw new AttuneGraphSourceAdapterError(
      "EXTRACTION_FAILED",
      "source adapter extraction failed",
      { cause }
    );
  }
  const assertions = normalizeExtraction(
    extraction,
    input.adapter.capabilities.maxAssertionsPerExtraction
  );
  const observationKey = `attunegraph-source-adapter@1:${JSON.stringify([
    input.adapter.metadata.id,
    input.adapter.metadata.version,
    input.sourceKind,
    input.correlationKey
  ])}`;
  if (Array.from(observationKey).length > MAX_OBSERVATION_KEY_CHARACTERS) {
    adapterError("INVALID_INPUT", "source adapter observation key exceeds its bound");
  }
  return {
    assertions,
    observationKey,
    observedAt: input.observedAt,
    schemaVersion: 2,
    scope: { ...input.scope },
    sourceFreshness: { ...input.sourceFreshness },
    threadRoot: { ...input.threadRoot }
  };
}

export function defineAttuneGraphSourceAdapter<
  Input,
  const SourceKinds extends readonly string[]
>(
  value: DefineAttuneGraphSourceAdapterOptions<Input, SourceKinds>
): AttuneGraphSourceAdapter<Input, SourceKinds[number]> {
  const record = dataRecord(
    value,
    "source adapter definition",
    ["capabilities", "extract", "metadata"],
    ["capabilities", "extract", "metadata"],
    "INVALID_DEFINITION"
  );
  const extract = dataValue(record, "extract");
  if (typeof extract !== "function" || nodeTypes.isProxy(extract)) {
    adapterError("INVALID_DEFINITION", "source adapter extract must be a data function");
  }
  const capabilities = normalizeCapabilities(dataValue(record, "capabilities"));
  const metadata = normalizeMetadata(dataValue(record, "metadata"));
  const adapter = Object.freeze({ capabilities, metadata }) as unknown as
    AttuneGraphSourceAdapter<Input, SourceKinds[number]>;
  registeredAdapters.set(adapter as object, {
    extract: extract as RegisteredAdapter["extract"]
  });
  return adapter;
}

export async function buildAttuneGraphSourceObservation<
  Input,
  SourceKind extends string
>(
  value: BuildAttuneGraphSourceObservationOptions<Input, SourceKind>
): Promise<AttuneGraphSourceObservationV2> {
  return extractObservation(normalizeBuildInput(value, [
    "adapter",
    "correlationKey",
    "input",
    "observedAt",
    "scope",
    "sourceFreshness",
    "sourceKind",
    "threadRoot"
  ]));
}

export async function projectAttuneGraphSource<
  Input,
  SourceKind extends string
>(
  value: ProjectAttuneGraphSourceOptions<Input, SourceKind>
): Promise<AttuneGraphSourceProjectionResult> {
  const normalized = normalizeBuildInput(value, [
    "adapter",
    "attuneGraph",
    "correlationKey",
    "input",
    "observedAt",
    "scope",
    "sourceFreshness",
    "sourceKind",
    "threadRoot"
  ]);
  const projectAgainstHead = dataMethod<AttuneGraph["projectAgainstHead"]>(
    normalized.attuneGraph,
    "projectAgainstHead"
  );
  const observation = await extractObservation(normalized);
  const snapshot = await projectAgainstHead({
    observation,
    operator: "canonical-projection@2"
  });
  return Object.freeze({ observation, snapshot });
}
