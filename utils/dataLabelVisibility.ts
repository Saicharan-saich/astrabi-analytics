import type { FormattingConfig } from '../types';

/** A single quick-toggle click must label every visible series. */
export function toggleDataLabels(formatting: FormattingConfig): FormattingConfig {
    if (!formatting.showDataLabels || formatting.dataLabelMode === 'off' || formatting.dataLabelMode === 'primary') {
        return { ...formatting, showDataLabels: true, dataLabelMode: 'all' };
    }
    return { ...formatting, showDataLabels: false, dataLabelMode: 'off' };
}

export function effectiveDataLabelMode(formatting?: FormattingConfig): 'off' | 'primary' | 'all' {
    if (!formatting?.showDataLabels || formatting.dataLabelMode === 'off') return 'off';
    return formatting.dataLabelMode === 'primary' ? 'primary' : 'all';
}

export function shouldRenderDataLabel(mode: 'off' | 'primary' | 'all', datasetIndex: number): boolean {
    return mode === 'all' || (mode === 'primary' && datasetIndex === 0);
}
