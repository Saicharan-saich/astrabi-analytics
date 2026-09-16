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
export { createAISQLBuilderHandoff } from './builderHandoff';
export type { AISQLBuilderHandoff } from './builderHandoff';
export {
    resolveConversationTurn,
    resolveConversationTurnWithAI,
    normalizeAIConversationResolution,
} from './conversationIntent';
export type {
    ConversationTurnKind,
    ConversationTurnResolution,
    AIConversationRoute,
    AIConversationTurnType,
    AIConversationResolution,
} from './conversationIntent';
export {
    allowedAggregationsForField,
    buildAnalyticalCapabilityContract,
    validatePlanAgainstCapabilityContract,
} from './analyticalCapabilityContract';
export type {
    AnalyticalCapabilityContract,
    CapabilityAggregation,
    CapabilityCheck,
    CapabilityFieldRule,
    CapabilityRelationshipRule,
    CapabilityStatus,
    CapabilityValidation,
} from './analyticalCapabilityContract';
export { buildAnalysisCertificate } from './analysisCertificate';
export type { AnalysisCertificate, AnalysisCertificateCheck } from './analysisCertificate';
export {
    detectBroadScopeQuestion, detectSummaryRequest, buildFocusedQuestionSuggestion,
    buildQuestionExamples, buildSummaryStoryQuestions,
} from './scopeIntent';
export type { BroadScopeDetection, SummaryIntentDetection, SummaryStoryQuestion } from './scopeIntent';
export {
    buildCanonicalQueryIntent,
    reconcilePlanWithCanonicalIntent,
    canonicalIntentToAnalysisIntent,
} from './canonicalIntent';
export type { CanonicalQueryIntent, CanonicalAnswerKind } from './canonicalIntent';

export type {
    SemanticField, SemanticModel, MetricDefinition, DerivedMetricDefinition,
    AnalysisPlan, AnalysisIntent, PlanDimension, PlanMetric, PlanFilter,
    ResultProfile, ChartRecommendation, RecommendedChart,
    ConfidenceScore, AuditEntry, AISQLPipelineResult,
    ValidationResult, ValidationCheck,
    FieldClassificationSignals,
    TrustVerification, TrustCheck,
    PipelineTrace, PipelineStepTrace, TraceStory, TraceStoryStep, ResultNarrative,
} from './types';
