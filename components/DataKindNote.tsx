import React, { useMemo } from 'react';
import { BarChart3, Hash, ListChecks } from 'lucide-react';
import type { Dataset } from '../types';
import { describeDatasetShape, type DatasetKind } from '../services/datasetShape';

const ICON: Record<DatasetKind, typeof Hash> = { hybrid: BarChart3, records: ListChecks, measures: Hash };
/** The three kinds in the words people use for them. */
const KIND_NAME: Record<DatasetKind, string> = { hybrid: 'Hybrid', records: 'Dimensional', measures: 'Measures' };

/**
 * What kind of data this is (amounts and categories, records with nothing to
 * add up, or numbers only) and how QuickInsight measures it. Worked out in
 * the browser from the columns; nothing is sent anywhere.
 */
export const DataKindNote: React.FC<{ dataset: Dataset; compact?: boolean }> = ({ dataset, compact }) => {
    const shape = useMemo(() => (dataset.rows?.length ? describeDatasetShape(dataset) : null), [dataset]);
    if (!shape) return null;
    const Icon = ICON[shape.kind];
    if (compact) {
        return (
            <p className="qi-kind-line" data-kind={shape.kind}>
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span><strong>{shape.label}.</strong> {shape.howMeasured}</span>
            </p>
        );
    }
    return (
        <section className="qi-ws-card qi-kind rounded-xl" data-kind={shape.kind} aria-label="Kind of data">
            <div className="qi-kind-mark"><Icon className="h-5 w-5" aria-hidden /></div>
            <div className="min-w-0">
                <p className="qi-ws-muted text-[12px]">Kind of data</p>
                <h3 className="qi-ws-strong text-[15px] font-semibold">
                    {shape.label} <span className="qi-kind-tag">{KIND_NAME[shape.kind]}</span>
                </h3>
                <p className="qi-ws text-[13px] mt-1">{shape.summary}</p>
                <p className="qi-ws text-[13px] mt-1">{shape.howMeasured}</p>
            </div>
        </section>
    );
};
