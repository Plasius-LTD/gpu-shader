import type {
  GitObjectId,
  ShaderQualificationExecutionProducer,
  ShaderQualificationPreflightManifest,
} from "../../contracts.js";
import {
  parseQualificationExecutionProducer,
  parseTrustedWorkflowProvenance,
} from "../evidence.js";

export type TrustedQualificationEnvironment = Readonly<Record<string, string | undefined>>;

function required(environment: TrustedQualificationEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new TypeError(`Trusted runner environment ${name} is required.`);
  return value;
}

function gitObject(value: string, label: string): GitObjectId {
  if (/^[a-f0-9]{40}$/u.test(value)) return { algorithm: "sha1", hex: value };
  if (/^[a-f0-9]{64}$/u.test(value)) return { algorithm: "sha256", hex: value };
  throw new TypeError(`${label} is not a lowercase Git object ID.`);
}

function integer(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive safe integer.`);
  return result;
}

/** Derives actual workflow/runner producer identity from fixed GitHub runner values. */
export function createQualificationExecutionProducer(input: {
  readonly preflight: ShaderQualificationPreflightManifest;
  readonly job: ShaderQualificationExecutionProducer["job"];
  readonly environment?: TrustedQualificationEnvironment;
}): ShaderQualificationExecutionProducer {
  const environment = input.environment ?? process.env;
  const provenance = parseTrustedWorkflowProvenance(input.preflight.provenance, "preflight.provenance");
  const producer: ShaderQualificationExecutionProducer = {
    repository: required(environment, "PLASIUS_CALLER_REPOSITORY"),
    commit: gitObject(required(environment, "PLASIUS_CALLER_SHA"), "PLASIUS_CALLER_SHA"),
    ref: required(environment, "PLASIUS_CALLER_REF"),
    runId: required(environment, "PLASIUS_WORKFLOW_RUN_ID"),
    runAttempt: integer(required(environment, "PLASIUS_WORKFLOW_RUN_ATTEMPT"), "PLASIUS_WORKFLOW_RUN_ATTEMPT"),
    job: input.job,
    trustedWorkflowRepository: required(environment, "PLASIUS_WORKFLOW_REPOSITORY") as "Plasius-LTD/gpu-shader",
    trustedWorkflowRef: required(environment, "PLASIUS_WORKFLOW_REF"),
    trustedWorkflowSha: gitObject(required(environment, "PLASIUS_WORKFLOW_SHA"), "PLASIUS_WORKFLOW_SHA"),
    runner: {
      name: required(environment, "RUNNER_NAME"),
      environment: required(environment, "RUNNER_ENVIRONMENT") as ShaderQualificationExecutionProducer["runner"]["environment"],
      // These identify the workflow runner/controller. Target device OS/build
      // belongs only in each qualification result's observed target snapshot.
      os: required(environment, "RUNNER_OS"),
      architecture: required(environment, "RUNNER_ARCH"),
    },
  };
  const parsed = parseQualificationExecutionProducer(producer);
  if (parsed.repository !== provenance.repository
    || parsed.commit.algorithm !== provenance.commit.algorithm
    || parsed.commit.hex !== provenance.commit.hex
    || parsed.ref !== provenance.ref
    || parsed.runId !== provenance.runId
    || parsed.runAttempt !== provenance.runAttempt
    || parsed.trustedWorkflowRef !== provenance.workflowRef
    || parsed.trustedWorkflowSha.algorithm !== provenance.workflowSha.algorithm
    || parsed.trustedWorkflowSha.hex !== provenance.workflowSha.hex) {
    throw new TypeError("Execution producer differs from the immutable qualification preflight provenance.");
  }
  return parsed;
}
