import { HOLDOUT_BENCHMARK_SUITES, HOLDOUT_MANIFEST_SHA256 } from './holdoutFixtures.generated';
import {
  HOLDOUT_AUDITED_MANIFEST_SHA256,
  HOLDOUT_ORACLE_AUDIT_SHA256,
  HOLDOUT_ORACLE_NOTES,
  HOLDOUT_ORACLE_QUALITY,
  HOLDOUT_SOURCE_MANIFEST_SHA256,
} from './holdoutOracleQuality.generated';
import type { BenchmarkCase, BenchmarkOracleQuality, BenchmarkSuite } from './types';

if (HOLDOUT_MANIFEST_SHA256 !== HOLDOUT_SOURCE_MANIFEST_SHA256) {
  throw new Error('The holdout oracle audit does not match the frozen source manifest. Re-audit before running.');
}

const sourceCases = HOLDOUT_BENCHMARK_SUITES.flatMap(suite => suite.cases);
const qualityByCaseId = HOLDOUT_ORACLE_QUALITY as Record<string, BenchmarkOracleQuality>;
const noteByCaseId = HOLDOUT_ORACLE_NOTES as Record<string, string>;
const sourceIds = new Set(sourceCases.map(testCase => testCase.id));
const auditedIds = Object.keys(qualityByCaseId);
if (sourceIds.size !== sourceCases.length
  || auditedIds.length !== sourceCases.length
  || auditedIds.some(id => !sourceIds.has(id))) {
  throw new Error('The holdout oracle audit must classify every frozen case exactly once.');
}

function annotate(testCase: BenchmarkCase): BenchmarkCase {
  const oracleQuality = qualityByCaseId[testCase.id];
  if (!oracleQuality) throw new Error(`Missing oracle-quality decision for ${testCase.id}`);
  return {
    ...testCase,
    oracleQuality,
    ...(oracleQuality !== 'no_issue_found'
      ? { oracleQualityNote: noteByCaseId[testCase.id] }
      : {}),
  };
}

export const HOLDOUT_QUARANTINED_CASES: BenchmarkCase[] = sourceCases
  .map(annotate)
  .filter(testCase => testCase.oracleQuality !== 'no_issue_found');

/**
 * Only quality-cleared cases are runnable. The original 550 questions remain
 * frozen and exported separately, but uncertain gold data can no longer alter
 * headline AI SQL accuracy.
 */
export const AUDITED_HOLDOUT_BENCHMARK_SUITES: BenchmarkSuite[] = HOLDOUT_BENCHMARK_SUITES.map(suite => {
  const annotated = suite.cases.map(annotate);
  const cases = annotated.filter(testCase => testCase.oracleQuality === 'no_issue_found');
  return {
    ...suite,
    version: `${suite.version}-audited-2026-09-03`,
    manifestSha256: HOLDOUT_AUDITED_MANIFEST_SHA256,
    sourceManifestSha256: HOLDOUT_SOURCE_MANIFEST_SHA256,
    oracleAuditSha256: HOLDOUT_ORACLE_AUDIT_SHA256,
    sourceCaseCount: annotated.length,
    quarantinedCaseCount: annotated.length - cases.length,
    description: `${cases.length} quality-cleared questions from the frozen ${annotated.length}-case source suite; ${annotated.length - cases.length} cases are quarantined from scoring pending correction or human adjudication.`,
    methodology: `${suite.methodology} Oracle-quality audit dated 2026-09-03; only no-issue-found cases are runnable.`,
    cases,
  };
});
