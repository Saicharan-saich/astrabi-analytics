/**
 * Global AI SQL engine configuration.
 *
 * The server copy is authoritative and is loaded for every signed-in user.
 * Defaults are deliberately fail-open for correctness: if the settings API is
 * unavailable, every optional reasoning/repair stage remains enabled.
 * Safety-critical boundaries are configurable for admin-led ablation, but
 * their disabled state is fail-closed: the pipeline pauses rather than
 * bypassing privacy, read-only validation, or local execution.
 */

export const AI_SQL_ENGINE_IDS = [
    'semanticLayer',
    'intentPlanner',
    'relationshipGraph',
    'privacyGateway',
    'llmSqlWriter',
    'readOnlySafety',
    'duckdbExecution',
    'timeResolver',
    'valueGrounding',
    'ambiguityResolver',
    'derivedMetricGuardrails',
    'planVerification',
    'canonicalAudit',
    'llmReviewer',
    'contractRepair',
    'sqlExecutionRepair',
    'semanticResultRepair',
    'resultContractValidation',
    'answerContractValidation',
] as const;

export type AISQLEngineId = typeof AI_SQL_ENGINE_IDS[number];

export interface AISQLEngineConfig {
    version: 1;
    engines: Record<AISQLEngineId, boolean>;
    updatedAt?: string;
    updatedBy?: string;
}
const allEnabled = (): Record<AISQLEngineId, boolean> => Object.fromEntries(
    AI_SQL_ENGINE_IDS.map(id => [id, true]),
) as Record<AISQLEngineId, boolean>;

export const DEFAULT_AI_SQL_ENGINE_CONFIG: AISQLEngineConfig = {
    version: 1,
    engines: allEnabled(),
};

export const AI_SQL_ENGINE_PRESETS = {
    production: allEnabled(),
    llmLed: {
        ...allEnabled(),
        ambiguityResolver: false,
        canonicalAudit: false,
        contractRepair: false,
        semanticResultRepair: false,
    },
} satisfies Record<string, Record<AISQLEngineId, boolean>>;

let activeConfig: AISQLEngineConfig = {
    ...DEFAULT_AI_SQL_ENGINE_CONFIG,
    engines: { ...DEFAULT_AI_SQL_ENGINE_CONFIG.engines },
};

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api';

function authHeaders(): Record<string, string> {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('qi_token') || '' : '';
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
}

export function normalizeAISQLEngineConfig(value: unknown): AISQLEngineConfig {
    const input = value && typeof value === 'object' ? value as Record<string, any> : {};
    const inputEngines = input.engines && typeof input.engines === 'object' ? input.engines : {};
    const engines = allEnabled();
    for (const id of AI_SQL_ENGINE_IDS) {
        if (typeof inputEngines[id] === 'boolean') engines[id] = inputEngines[id];
    }
    return {
        version: 1,
        engines,
        ...(typeof input.updatedAt === 'string' ? { updatedAt: input.updatedAt } : {}),
        ...(typeof input.updatedBy === 'string' ? { updatedBy: input.updatedBy } : {}),
    };
}

export function getAISQLEngineConfig(): AISQLEngineConfig {
    return activeConfig;
}

export function setAISQLEngineConfig(value: unknown): AISQLEngineConfig {
    activeConfig = normalizeAISQLEngineConfig(value);
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('qi:ai-sql-engine-config', { detail: activeConfig }));
    }
    return activeConfig;
}

export async function fetchAISQLEngineConfig(): Promise<AISQLEngineConfig> {
    try {
        const response = await fetch(`${API_BASE}/settings/ai-sql-engines`, { headers: authHeaders() });
        if (!response.ok) return activeConfig;
        return setAISQLEngineConfig(await response.json());
    } catch {
        return activeConfig;
    }
}

export async function saveAISQLEngineConfig(config: AISQLEngineConfig): Promise<{ ok: boolean; config: AISQLEngineConfig; error?: string }> {
    try {
        const response = await fetch(`${API_BASE}/admin/ai-sql-engines`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ engines: normalizeAISQLEngineConfig(config).engines }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            return { ok: false, config: activeConfig, error: body?.error || 'Could not save AI SQL engine settings.' };
        }
        return { ok: true, config: setAISQLEngineConfig(body.config || config) };
    } catch {
        return { ok: false, config: activeConfig, error: 'Could not connect to the settings service.' };
    }
}
