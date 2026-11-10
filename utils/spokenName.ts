/**
 * A column name as a person would say it: "net_sales" → "net sales",
 * "lineitem_name" → "product", and a looked-up column from another sheet,
 * "sku → Products.title" → "product", "order → Orders / email → Customers.city" → "city".
 */
const singular = (word: string) => word.replace(/ies$/i, 'y').replace(/(ss|us)$/i, '$1').replace(/s$/i, '');
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

export function spokenName(name: string): string {
    if (name.includes(' → ')) {
        const leaf = name.split('.').pop() || name;
        const table = name.split(' → ').pop()!.split('.')[0];
        if (/^(name|title|label|description)$/i.test(leaf)) return singular(words(table));
        return spokenName(leaf);
    }
    const w = words(name);
    if (/^(line ?item|product|item|variant) (name|title)$/.test(w)) return w.startsWith('item') ? 'item' : 'product';
    return w;
}
