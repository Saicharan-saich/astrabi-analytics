export type AISQLPipelineFailureKind =
    | 'conversation_only'
    | 'clarification_required'
    | 'summary_story_required'
    | 'planner_invalid_spec'
    | 'capability_contract_violation'
    | 'sql_validation_failed';

/** A deliberate, typed pipeline stop that occurs before SQL execution. */
export class AISQLPipelineError extends Error {
    readonly kind: AISQLPipelineFailureKind;

    constructor(kind: AISQLPipelineFailureKind, message: string) {
        super(message);
        this.name = 'AISQLPipelineError';
        this.kind = kind;
    }
}
