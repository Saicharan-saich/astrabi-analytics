/**
 * What a number column means, from the words in its name (never its values):
 *
 *   per-row   a figure that belongs to each row — averaged, never added up
 *             (unit price, age, temperature, rating, discount_pct, wait days)
 *   amount    adds up across rows (sales, cost, quantity, units, fees)
 *
 * Words are matched whole, so "discount" is not "count", "percentage" is not
 * "age" and "storage" is not "age" either.
 */
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/%/g, ' pct ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Words that say "this was already averaged or divided": they win over everything. */
const AVERAGED = new Set(['unit', 'per', 'avg', 'average', 'mean', 'median', 'rate', 'ratio', 'pct', 'percent', 'percentage', 'share', 'proportion']);
const TOTAL = new Set(['total', 'sum', 'gross', 'net', 'cumulative']);
const ADDITIVE = new Set(['revenue', 'revenues', 'sales', 'amount', 'amt', 'quantity', 'qty', 'units', 'profit', 'profits', 'cost', 'costs',
    'spend', 'spending', 'value', 'count', 'income', 'turnover', 'orders', 'volume', 'gmv', 'fee', 'fees', 'tax', 'taxes', 'earnings',
    'budget', 'salary', 'salaries', 'charges', 'paid', 'sold', 'payment', 'payments', 'expense', 'expenses', 'refund', 'refunds',
    'discount', 'discounts', 'bookings', 'visits', 'clicks', 'impressions', 'sessions', 'calls', 'downloads', 'installs', 'tickets']);
const PER_ROW = new Set(['score', 'rating', 'ratings', 'age', 'temperature', 'temp', 'probability', 'prob', 'nps', 'satisfaction',
    'index', 'level', 'price', 'size', 'weight', 'height', 'length', 'width', 'bmi', 'mileage', 'miles', 'km', 'distance', 'duration',
    'speed', 'capacity', 'tenure', 'days', 'hours', 'minutes', 'seconds', 'diff', 'wait', 'lead', 'delay', 'gap', 'elapsed', 'cpi',
    'unemployment', 'inflation', 'interest', 'humidity', 'rainfall', 'pressure', 'glucose', 'cholesterol', 'bp', 'margin', 'engine',
    'horsepower', 'hp', 'rpm', 'year', 'years', 'stars', 'latitude', 'longitude', 'lat', 'lon', 'lng', 'balance', 'stock', 'inventory',
    'headcount', 'population', 'density', 'altitude', 'elevation', 'bedrooms', 'bathrooms', 'rooms']);

/** A number that belongs to each row (average it, never add it up). */
export function isPerRowName(name: string): boolean {
    const list = words(name);
    if (list.some(word => AVERAGED.has(word))) return true;
    if (list.some(word => TOTAL.has(word))) return false;
    if (list.some(word => ADDITIVE.has(word))) return false;
    return list.some(word => PER_ROW.has(word));
}

/** A number that adds up across rows. */
export function isAdditiveName(name: string): boolean {
    const list = words(name);
    if (list.some(word => AVERAGED.has(word))) return false;
    return list.some(word => TOTAL.has(word) || ADDITIVE.has(word));
}

/** Map coordinates: a position, not a measure or a grouping. */
export const isCoordinateName = (name: string) => words(name).some(word => ['lat', 'latitude', 'lon', 'lng', 'longitude'].includes(word));
