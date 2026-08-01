import {
  canonicalizeImmutableEnvelope,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import type { AttuneGraphScope } from "./attunegraph-contracts.js";
import {
  normalizeAttuneGraphScope,
  normalizeStoredProjection,
  normalizeStoredProjectionForPortableDecoder
} from "./attunegraph-engine.js";
import { AttuneGraphError } from "./attunegraph-error.js";

const STORE_ENVELOPE_SPEC = Object.freeze({
  hashDomain: "attunegraph.store-projection.v1",
  idField: "storeEnvelopeId",
  idPrefix: "attunegraph-store:"
} as const);

export interface AdmittedPortableProjection {
  readonly projection: AttuneGraphStoredProjection;
  readonly identity: {
    readonly scope: AttuneGraphScope;
    readonly generation: number;
    readonly commitId: string;
    readonly projectionId: `attunegraph-store:${string}`;
  };
}

function admitNormalizedPortableProjection(
  projection: AttuneGraphStoredProjection
): AdmittedPortableProjection {
  const minted =
    mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      projection,
      STORE_ENVELOPE_SPEC
    );
  const readmitted = canonicalizeImmutableEnvelope(
    minted.envelope,
    "attunegraph-frozen",
    STORE_ENVELOPE_SPEC
  );
  if (
    readmitted.contentId !== minted.contentId
    || readmitted.canonicalJson !== minted.canonicalJson
    || readmitted.canonicalByteLength !== minted.canonicalByteLength
  ) {
    throw new AttuneGraphError(
      "CORRUPT_STORE",
      "Portable projection store identity does not bind to its normalized projection"
    );
  }
  const scope = Object.freeze({
    sourceId: projection.snapshot.scope.sourceId,
    threadId: projection.snapshot.scope.threadId
  });
  const identity = Object.freeze({
    scope,
    generation: projection.snapshot.generation,
    commitId: projection.snapshot.commitId,
    projectionId: readmitted.contentId as `attunegraph-store:${string}`
  });
  return Object.freeze({ projection, identity });
}

export function admitPortableProjection(
  value: unknown,
  expectedScope: AttuneGraphScope
): AdmittedPortableProjection {
  const normalizedExpectedScope = normalizeAttuneGraphScope(
    expectedScope,
    "portable projection expected scope"
  );
  const projection = normalizeStoredProjection(value, normalizedExpectedScope);
  return admitNormalizedPortableProjection(projection);
}

export function admitPortableProjectionForDecoder(
  value: unknown
): AdmittedPortableProjection {
  const minted =
    mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      value,
      STORE_ENVELOPE_SPEC
    );
  const admitted = normalizeStoredProjectionForPortableDecoder(
    minted
  );
  const rebound =
    mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      admitted.projection,
      STORE_ENVELOPE_SPEC
    );
  if (
    admitted.projectionId !== minted.contentId
    || rebound.contentId !== minted.contentId
    || rebound.canonicalJson !== minted.canonicalJson
    || rebound.canonicalByteLength !== minted.canonicalByteLength
  ) {
    throw new AttuneGraphError(
      "CORRUPT_STORE",
      "Portable decoder projection identity does not match its stored envelope"
    );
  }
  const scope = Object.freeze({
    sourceId: admitted.projection.snapshot.scope.sourceId,
    threadId: admitted.projection.snapshot.scope.threadId
  });
  const identity = Object.freeze({
    scope,
    generation: admitted.projection.snapshot.generation,
    commitId: admitted.projection.snapshot.commitId,
    projectionId: rebound.contentId as `attunegraph-store:${string}`
  });
  return Object.freeze({ projection: admitted.projection, identity });
}
