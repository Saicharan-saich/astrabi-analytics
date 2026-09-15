/** A compact, machine-readable certificate attached to every analytical answer. */
import type { AISQLPipelineResult } from './types';
import type { AnalyticalCapabilityContract, CapabilityCheck, CapabilityValidation } from './analyticalCapabilityContract';

export interface AnalysisCertificateCheck {
    id: string;
    category: 'capability' | 'sql' | 'meaning' | 'result' | 'privacy';
    status: 'pass' | 'warn' | 'fail';
    title: string;
    detail: string;
}
export interface AnalysisCertificate {
    version: 1;
    certificateId: string;
    status: 'certified' | 'conditional' | 'withheld';
    contractId: string;
    question: string;
    dataset: {
        name: string;
        revision?: string;
        grain: string;
        grainConfidence: 'high' | 'medium' | 'low';
    };
    checks: AnalysisCertificateCheck[];
    execution: {
        engine: string;
        locality: 'local_duckdb';
        rowCount: number;
        sqlFingerprint: string;
        repairAttempts: number;
        llmUsed: boolean;
        aiDataAccess: 'metadata_only' | 'approved_safe_values';
        tokenUsage: number;
    };
    limitations: string[];
    summary: string;
}

function stableHash(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function capabilityCheck(check: CapabilityCheck): AnalysisCertificateCheck {
    return {
        id: check.id,
        category: 'capability',
        status: check.status,
        title: check.title,
        detail: check.detail,
    };
}

export function buildAnalysisCertificate(args: {
    question: string;
    contract: AnalyticalCapabilityContract;
    capabilityValidation: CapabilityValidation;
    result: AISQLPipelineResult;
}): AnalysisCertificate {
    const { question, contract, capabilityValidation, result } = args;
    const checks: AnalysisCertificateCheck[] = capabilityValidation.checks.map(capabilityCheck);

    for (const check of result.validation.checks) {
        checks.push({ id: `sql:${check.name}`, category: 'sql', status: check.status, title: check.name, detail: check.message });
    }
    for (const issue of result.analyticalValidation?.issues || []) {
        checks.push({
            id: `meaning:${issue.code}`,
            category: 'meaning',
            status: issue.severity === 'error' ? 'fail' : 'warn',
            title: issue.code.replace(/_/g, ' '),
            detail: issue.message,
        });
    }
    for (const check of result.contractValidation?.checks || []) {
        checks.push({
            id: `result:${check.name}`,
            category: 'result',
            status: check.status === 'skip' ? 'warn' : check.status,
            title: check.name,
            detail: check.message,
        });
    }
    checks.push({
        id: 'privacy:execution',
        category: 'privacy',
        status: 'pass',
        title: 'Local execution',
        detail: `DuckDB executed the query locally; AI access was ${result.provenance?.dataAccess === 'approved_safe_values' ? 'limited to approved safe values and metadata' : 'metadata only'}.`,
    });

    const failed = checks.filter(check => check.status === 'fail');
    const warnings = checks.filter(check => check.status === 'warn');
    const displayBlocked = result.displaySafety?.allowed === false;
    const status: AnalysisCertificate['status'] = failed.length || displayBlocked
        ? 'withheld'
        : warnings.length
            ? 'conditional'
            : 'certified';
    const limitations = [
        ...capabilityValidation.checks.filter(check => check.status === 'warn').map(check => check.detail),
        ...(result.displaySafety?.reasons || []),
    ].filter((value, index, all) => value && all.indexOf(value) === index);
    const sqlFingerprint = `fnv1a-${stableHash(result.sql || '')}`;
    const certificateId = `answer-v1-${stableHash([contract.contractId, question, sqlFingerprint, status].join('|'))}`;

    return {
        version: 1,
        certificateId,
        status,
        contractId: contract.contractId,
        question,
        dataset: {
            name: contract.datasetName,
            revision: contract.datasetRevision,
            grain: contract.grain.label,
            grainConfidence: contract.grain.confidence,
        },
        checks,
        execution: {
            engine: result.engine || 'unknown',
            locality: 'local_duckdb',
            rowCount: result.rawData.length,
            sqlFingerprint,
            repairAttempts: result.repairAttempts,
            llmUsed: result.provenance?.strategy !== 'deterministic',
            aiDataAccess: result.provenance?.dataAccess || 'metadata_only',
            tokenUsage: result.tokenUsage?.total || 0,
        },
        limitations,
        summary: status === 'certified'
            ? 'Certified: grain, fields, aggregation, SQL, result shape and privacy checks passed.'
            : status === 'conditional'
                ? `Conditional: the answer passed blocking checks with ${warnings.length} limitation${warnings.length === 1 ? '' : 's'} disclosed.`
                : `Withheld: ${failed.length || 1} blocking verification issue${(failed.length || 1) === 1 ? '' : 's'} must be resolved before display.`,
    };
}
