// Phase 5.3 — Product build contract (provider-neutral) + deployment provider
// contract. Boundaries only: no real build/deployment provider is connected in
// this milestone, and the default adapters report DEPLOYMENT_NOT_CONNECTED /
// UNAVAILABLE rather than faking success.
//
// Safety invariants:
// - A BuildResult can never claim success without a non-empty artifact ref and
//   passing quality gates; the deterministic local validator refuses specs
//   that lack required structure.
// - Generated code is NEVER executed by this layer: the build contract carries
//   a `sandboxed: true` flag and the boundary refuses any builder that does
//   not declare one. Arbitrary code execution stays structurally impossible.
// - DEPLOYED requires the provider's own confirmation (real deployment id +
//   URL). The unavailable adapter cannot produce one.
// - Credentials are never accepted as inputs — the provider adapter reads its
//   own server-side env; nothing here forwards secrets anywhere.

// ---------------------------------------------------------------------------
// Build contract
// ---------------------------------------------------------------------------

import type { PublishableProductSpec } from '@/lib/publishing/contract';

export type BuildStatus = 'NOT_BUILT' | 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE';

export interface QualityGateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface BuildResult {
  status: BuildStatus;
  /** Reference to build artifacts (path/id). Null when nothing was built. */
  artifactRef: string | null;
  version: string | null;
  tests: { total: number; passed: number; failed: number } | null;
  /** Bounded, secret-free build log summary. */
  logSummary: string | null;
  qualityGates: QualityGateResult[];
  generatedAt: string;
  /** Every builder must run inside a sandbox; the boundary enforces this. */
  sandboxed: true;
  errors: string[];
}

export interface ProductBuilder {
  readonly id: string;
  /** Declared sandbox requirement — non-sandboxed builders are refused. */
  readonly sandboxed: true;
  validate(spec: PublishableProductSpec): { valid: boolean; errors: string[] };
  build(spec: PublishableProductSpec): Promise<BuildResult>;
}

/** Deterministic local quality gates over the spec (no execution). */
export function runQualityGates(spec: PublishableProductSpec): QualityGateResult[] {
  return [
    {
      gate: 'spec-completeness',
      passed: spec.name.trim().length > 0 && spec.problem.trim().length > 0 && spec.valueProposition.trim().length > 0,
      detail: 'Name, problem, and value proposition must be present.',
    },
    {
      gate: 'mvp-defined',
      passed: spec.mvpFeatures.length > 0,
      detail: 'At least one MVP feature must be specified.',
    },
    {
      gate: 'build-plan-defined',
      passed: spec.buildPhases.length > 0,
      detail: 'A phased build plan must be specified.',
    },
    {
      gate: 'monetization-defined',
      passed: spec.monetizationModel.trim().length > 0,
      detail: 'A monetization model must be specified.',
    },
    {
      gate: 'provenance-labelled',
      passed: spec.evidenceProvenance !== 'MOCKED',
      detail: 'Specification provenance must be recorded (MOCKED output is flagged, not hidden).',
    },
    {
      gate: 'no-guaranteed-claims',
      passed: !/\b(guaranteed|risk[- ]free|100% (?:success|profit)|money[- ]back guarantee)\b/i.test(
        [spec.valueProposition, ...spec.assumptions].join(' '),
      ),
      detail: 'No guaranteed-income / risk-free claims are allowed in the specification.',
    },
  ];
}

export function validateSpecForBuild(spec: PublishableProductSpec): { valid: boolean; errors: string[] } {
  const gates = runQualityGates(spec);
  const errors = gates.filter((g) => !g.passed).map((g) => `${g.gate}: ${g.detail}`);
  return { valid: errors.length === 0, errors };
}

/** Resolve the configured builder. None is connected in this milestone. */
export function resolveProductBuilder(): ProductBuilder | null {
  return null;
}

// ---------------------------------------------------------------------------
// Deployment provider contract
// ---------------------------------------------------------------------------

export type DeploymentStatus =
  | 'DEPLOYMENT_NOT_CONNECTED'
  | 'VALIDATION_FAILED'
  | 'BUILDING'
  | 'DEPLOYING'
  | 'DEPLOYED'
  | 'FAILED'
  | 'ROLLED_BACK';

export interface DeploymentTarget {
  /** Provider-neutral target descriptor (e.g. 'NEXTJS', 'STATIC_SITE'). */
  target: string;
  /** Product/artifact reference being deployed. */
  artifactRef: string;
}

export interface DeploymentRecord {
  status: DeploymentStatus;
  providerId: string | null;
  /** Provider-confirmed deployment id. Null until a real provider confirms. */
  deploymentId: string | null;
  /** Provider-confirmed live URL. Null until a real provider confirms. */
  url: string | null;
  version: string | null;
  errors: string[];
  timestamp: string;
}

export interface DeploymentProvider {
  readonly id: string;
  validate(target: DeploymentTarget): { valid: boolean; errors: string[] };
  build(target: DeploymentTarget): Promise<BuildResult>;
  deploy(target: DeploymentTarget, humanApprovalToken: string): Promise<DeploymentRecord>;
  status(deploymentId: string): Promise<DeploymentRecord>;
  rollback(deploymentId: string, humanApprovalToken: string): Promise<DeploymentRecord>;
}

/**
 * The not-connected deployment adapter: honest about being unavailable.
 * deploy() and rollback() can never produce a confirmed deployment record —
 * status is always DEPLOYMENT_NOT_CONNECTED and the record carries no id/URL,
 * which structurally prevents the lifecycle from marking a product DEPLOYED.
 */
export function createUnavailableDeploymentProvider(channel = 'generic'): DeploymentProvider {
  const errors = [
    `No deployment provider is connected (channel: ${channel}). Nothing was built or deployed. `
      + 'Implement a DeploymentProvider adapter with server-side credentials to enable deployments.',
  ];
  return {
    id: 'unavailable',
    validate: () => ({ valid: false, errors }),
    build: async () => ({
      status: 'UNAVAILABLE',
      artifactRef: null,
      version: null,
      tests: null,
      logSummary: null,
      qualityGates: [],
      generatedAt: new Date().toISOString(),
      sandboxed: true,
      errors,
    }),
    deploy: async () => ({
      status: 'DEPLOYMENT_NOT_CONNECTED',
      providerId: null,
      deploymentId: null,
      url: null,
      version: null,
      errors,
      timestamp: new Date().toISOString(),
    }),
    status: async () => ({
      status: 'DEPLOYMENT_NOT_CONNECTED',
      providerId: null,
      deploymentId: null,
      url: null,
      version: null,
      errors,
      timestamp: new Date().toISOString(),
    }),
    rollback: async () => ({
      status: 'DEPLOYMENT_NOT_CONNECTED',
      providerId: null,
      deploymentId: null,
      url: null,
      version: null,
      errors,
      timestamp: new Date().toISOString(),
    }),
  };
}

/** Resolve the configured deployment provider. None exists in this milestone. */
export function resolveDeploymentProvider(): DeploymentProvider {
  return createUnavailableDeploymentProvider();
}

/** Truthful deployment readiness for dashboards. */
export function describeDeploymentStatus(): {
  status: 'DEPLOYMENT_NOT_CONNECTED';
  note: string;
  providers: string[];
} {
  return {
    status: 'DEPLOYMENT_NOT_CONNECTED',
    note:
      'Deployment contracts (validate/build/deploy/status/rollback) are implemented with provider-neutral '
        + 'boundaries. No deployment provider is connected, so every deployment reports '
        + 'DEPLOYMENT_NOT_CONNECTED. Credentials stay server-side and are never exposed to AI prompts.',
    providers: ['vercel', 'generic'],
  };
}
