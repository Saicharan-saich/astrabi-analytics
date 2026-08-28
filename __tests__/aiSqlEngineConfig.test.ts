import { describe, expect, it } from 'vitest';
import {
    AI_SQL_ENGINE_IDS,
    AI_SQL_ENGINE_PRESETS,
    normalizeAISQLEngineConfig,
} from '../services/ai-sql/engineConfig';

describe('AI SQL engine configuration', () => {
    it('fails open with every optional stage enabled', () => {
        const config = normalizeAISQLEngineConfig(undefined);
        expect(AI_SQL_ENGINE_IDS.every(id => config.engines[id])).toBe(true);
    });

    it('accepts only known boolean engine values', () => {
        const config = normalizeAISQLEngineConfig({
            version: 99,
            engines: {
                llmReviewer: false,
                timeResolver: 'no',
                unknownEngine: false,
            },
        });
        expect(config.version).toBe(1);
        expect(config.engines.llmReviewer).toBe(false);
        expect(config.engines.timeResolver).toBe(true);
        expect(Object.keys(config.engines)).toEqual([...AI_SQL_ENGINE_IDS]);
    });

    it('keeps privacy and SQL safety out of the configurable surface', () => {
        expect(AI_SQL_ENGINE_IDS).not.toContain('privacyGateway');
        expect(AI_SQL_ENGINE_IDS).not.toContain('readOnlySafety');
        expect(AI_SQL_ENGINE_IDS).not.toContain('duckdbExecution');
    });

    it('provides a full-on production preset and a reduced-intervention LLM-led preset', () => {
        expect(AI_SQL_ENGINE_IDS.every(id => AI_SQL_ENGINE_PRESETS.production[id])).toBe(true);
        expect(AI_SQL_ENGINE_PRESETS.llmLed.llmReviewer).toBe(true);
        expect(AI_SQL_ENGINE_PRESETS.llmLed.contractRepair).toBe(false);
        expect(AI_SQL_ENGINE_PRESETS.llmLed.semanticResultRepair).toBe(false);
    });
});
