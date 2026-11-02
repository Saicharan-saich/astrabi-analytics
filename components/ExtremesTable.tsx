import React from 'react';

/** Format a value with the answer's currency, when it has one. */
const formatValue = (value: unknown, currency?: string) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    try {
        return currency
            ? number.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: Math.abs(number) >= 1000 ? 0 : 2 })
            : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
    } catch {
        return number.toLocaleString();
    }
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const groupLabel = (value: unknown) => {
    const match = String(value ?? '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!match) return String(value ?? '');
    const month = MONTHS[Number(match[2]) - 1];
    return match[3] && match[3] !== '01' ? `${Number(match[3])} ${month} ${match[1]}` : `${month} ${match[1]}`;
};

const title = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * "Highest and lowest per group" answers: one row per group, with the item
 * name and value for each role, so the names are visible without hovering.
 */
export const ExtremesTable: React.FC<{
    rows: Record<string, any>[];
    groupKey: string;
    /** value column → item column, e.g. highest_total_sales → highest_product */
    pointLabelKeys: Record<string, string>;
    currency?: string;
    maxRows?: number;
}> = ({ rows, groupKey, pointLabelKeys, currency, maxRows = 60 }) => {
    const roles = Object.entries(pointLabelKeys).map(([valueKey, itemKey]) => ({
        valueKey, itemKey, label: title(valueKey.split('_')[0]),
    }));
    const shown = rows.filter(row => roles.some(role => row[role.itemKey] !== undefined)).slice(0, maxRows);
    return (
        <div className="qi-extremes" role="region" aria-label="Each group's items">
            <table className="qi-extremes-table">
                <thead>
                    <tr>
                        <th scope="col">{title(groupKey.replace(/_/g, ' '))}</th>
                        {roles.map(role => <th key={role.valueKey} scope="col">{role.label}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {shown.map((row, index) => (
                        <tr key={index}>
                            <th scope="row">{groupLabel(row[groupKey])}</th>
                            {roles.map(role => (
                                <td key={role.valueKey}>
                                    <span className="qi-extremes-name">{String(row[role.itemKey] ?? '—')}</span>
                                    <span className="qi-extremes-value">{formatValue(row[role.valueKey], currency)}</span>
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};
