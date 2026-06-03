/**
 * AI SQL Module — Barrel Export
 *
 * Re-exports all public APIs from the enterprise AI SQL architecture.
 */

export { runAISQLPipeline } from './pipeline';
export { buildSemanticModel, serializeSemanticModel, enhanceWithAIArbitration } from './semanticLayer';
export { generatePlan } from './intentPlanner';
export { generateSQLFromPlan, repairSQL } from './sqlGenerator';
export { correctSQL } from './sqlCorrectionEngine';
export { validateSQL, validateResult } from './sqlValidator';
export { profileResult } from './resultProfiler';
export { recommendChart } from './chartRecommender';
export { reshapeData } from './dataReshaper';
export { scoreConfidence } from './confidenceScorer';
export { logAuditEntry, getAuditLog, clearAuditLog, getAuditStats } from './auditLogger';
export { buildCompositeMetrics, buildDerivedMetrics } from './metricRegistry';
export { resolveTimeContext, augmentQuestionWithTime } from './timeResolver';
export { storeUserOverride } from './classificationFeedback';
export { getClassificationTelemetry } from './arbitrationEngine';
export { generateTrustVerification } from './trustEngine';

export type {
    SemanticField, SemanticModel, MetricDefinition, DerivedMetricDefinition,
    AnalysisPlan, AnalysisIntent, PlanDimension, PlanMetric, PlanFilter,
    ResultProfile, ChartRecommendation, RecommendedChart,
    ConfidenceScore, AuditEntry, AISQLPipelineResult,
    ValidationResult, ValidationCheck,
    FieldClassificationSignals,
    TrustVerification, TrustCheck,
} from './types';
