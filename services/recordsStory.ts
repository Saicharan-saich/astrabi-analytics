/**
 * The data story for records with nothing to add up (appointments, patients,
 * tickets, survey answers). There are no sales to total, so the story counts
 * rows and compares the share with each outcome:
 *
 *   overview   how many records, people and the outcome rate
 *   drivers    which yes/no answers, categories, age or waiting-time ranges
 *              and weekdays go with the outcome — and whether another factor
 *              may explain a gap
 *   where      the best and worst places (or other many-valued groups)
 *   repeats    whether a few people account for many of the bad outcomes
 *   mix        how common each yes/no answer and category is
 *   trend      records and the outcome rate over time
 *
 * Worked out in the browser from every row; nothing is sent anywhere.
 */
import type { Dataset } from '../types';
import type { StoryChart, StoryFinding, StoryKpi } from './dataStory';
import { flagSubject, lowerLabel, yesNoLabel } from './ai-sql/plainLabels';
import { numberLabel, idWord, type DatasetShape } from './datasetShape';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** The "yes" side is the problem (a no-show, a churn): the story focuses on it. */
const BAD_WHEN_YES = /(no.?show|churn|cancel|default|fraud|fail|died|death|dead|deceased|late|defect|spam|reject|readmi|left|attrition|exit|lost|stroke|disease|complain|missed|absent|delay|return)/i;
/** The "yes" side is the good result (showed up, converted): the story focuses on "no". */
const GOOD_WHEN_YES = /(show|attend|paid|convert|success|surviv|pass|complet|approved|renew|retain|won|purchas|click|respon|hired|on.?time|accept|resolv|subscri|enrol|bought|active)/i;

const human = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (word: string) => /(s|x|ch|sh)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
const count = (value: number) => Math.round(value).toLocaleString('en-GB');
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
const points = (gap: number) => `${Math.abs(gap * 100).toFixed(1)} point${Math.abs(gap * 100).toFixed(1) === '1.0' ? '' : 's'}`;
const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const asNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
    return null;
};
const asDay = (value: unknown): string | null => {
    if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
};
const monthLabel = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const round1 = (value: number) => Math.round(value * 1000) / 10;

interface Rate { key: string; n: number; hits: number; rate: number; order?: number }

/** Bands for a number: ages, days waited, or fifths of the range. */
function bandsFor(name: string, values: number[], isDays: boolean): { label: (v: number) => string | null; order: (label: string) => number } {
    const sorted = [...values].sort((a, b) => a - b);
    let edges: { max: number; label: string }[];
    if (/(^|_)age($|_)/i.test(name) || /^age/i.test(name)) {
        edges = [{ max: 17, label: '0–17' }, { max: 34, label: '18–34' }, { max: 49, label: '35–49' }, { max: 64, label: '50–64' }, { max: Infinity, label: '65+' }];
    } else if (isDays) {
        edges = [{ max: 0, label: 'same day' }, { max: 7, label: '1–7 days' }, { max: 14, label: '8–14 days' }, { max: 30, label: '15–30 days' }, { max: 60, label: '31–60 days' }, { max: Infinity, label: '61+ days' }];
    } else {
        const cuts = [...new Set([0.2, 0.4, 0.6, 0.8].map(q => sorted[Math.floor(q * (sorted.length - 1))]))];
        const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-GB') : String(Math.round(v * 10) / 10));
        edges = [];
        let low = sorted[0];
        for (const cut of cuts) { edges.push({ max: cut, label: `${fmt(low)}–${fmt(cut)}` }); low = cut; }
        edges.push({ max: Infinity, label: `over ${fmt(low)}` });
    }
    const negatives = sorted[0] < 0;
    return {
        label: v => (negatives && isDays && v < 0 ? null : edges.find(e => v <= e.max)?.label ?? null),
        order: label => edges.findIndex(e => e.label === label),
    };
}

/** Which side of the outcome the story follows, in words: "didn't show up", "churned". */
export function outcomeFocus(outcome: string): { badIsYes: boolean; focusWords: string } {
    const yesText = yesNoLabel(outcome, true);
    const badIsYes = BAD_WHEN_YES.test(outcome) || !GOOD_WHEN_YES.test(outcome);
    const focusText = badIsYes ? yesText : yesNoLabel(outcome, false);
    return { badIsYes, focusWords: lowerLabel(focusText) };
}

/** Starter questions for records with nothing to add up (no values used). */
export function recordsQuestions(shape: DatasetShape): string[] {
    const records = shape.recordsWord;
    const out: string[] = [];
    const place = shape.categories.find(c => /(neighbou?rhood|city|town|region|area|clinic|branch|location|site|department|hospital|doctor|store|country|state|ward|team|channel|source)/i.test(c)) || shape.categories[0];
    const small = shape.yesNo.filter(c => c !== shape.outcome);
    if (shape.outcome) {
        const { focusWords } = outcomeFocus(shape.outcome);
        if (place) out.push(`What % of ${records} ${focusWords}, by ${human(place)}?`);
        const wait = shape.perRowNumbers.find(n => shape.dayGaps[n]);
        if (wait) out.push(`Does a longer wait from ${human(shape.dayGaps[wait].from)} to ${human(shape.dayGaps[wait].to)} mean more ${focusWords}?`);
        if (small[0]) out.push(`Compare the % that ${focusWords} with and without ${lowerLabel(flagSubject(small[0]))}`);
        const attribute = shape.perRowNumbers.find(n => !shape.dayGaps[n]);
        if (attribute) out.push(`What % ${focusWords} by ${human(attribute)} group?`);
        if (shape.entityIds[0]) out.push(`Which ${plural(idWord(shape.entityIds[0]))} ${focusWords} most often?`);
    } else {
        if (place) out.push(`How many ${records} are there by ${human(place)}?`);
        if (small[0]) out.push(`What % of ${records} have ${lowerLabel(flagSubject(small[0]))}?`);
        const attribute = shape.perRowNumbers[0];
        if (attribute && place) out.push(`Average ${numberLabel(attribute, shape.dayGaps)} by ${human(place)}`);
        if (shape.entityIds[0]) out.push(`How many distinct ${plural(idWord(shape.entityIds[0]))} are there?`);
    }
    if (shape.dates[0]) out.push(`How many ${records} are there by month?`);
    return out.slice(0, 6);
}

export interface RecordsStory {
    findings: StoryFinding[];
    subtitle: string[];
    /** The measure named first in the subtitle: "Appointments". */
    lead: string;
}

export function buildRecordsStory(rows: Record<string, any>[], dataset: Pick<Dataset, 'columns'>, shape: DatasetShape, question = ''): RecordsStory {
    const findings: StoryFinding[] = [];
    // Yes/no answers as words ("SMS received" / "SMS not received"), whatever the file stored.
    const raw = /^(1|0|true|false|yes|no|y|n|t|f)$/i;
    if (shape.yesNo.length && rows.some(row => shape.yesNo.some(c => raw.test(String(row[c] ?? ''))))) {
        rows = rows.map(row => {
            const copy = { ...row };
            for (const c of shape.yesNo) if (!isBlank(row[c]) && raw.test(String(row[c]))) copy[c] = yesNoLabel(c, row[c]);
            return copy;
        });
    }
    const n = rows.length;
    const records = shape.recordsWord;
    const recordsCap = capital(records);
    const subtitle: string[] = [];
    if (!n) return { findings, subtitle, lead: recordsCap };

    // ── the event date: the one named like the record ("appointment_day") ──
    const eventDate = shape.dates.find(d => human(d).includes(shape.recordWord)) || shape.dates.find(d => !Object.values(shape.dayGaps).some(g => g.from === d)) || shape.dates[0];
    const days = eventDate ? rows.map(row => asDay(row[eventDate])).filter((d): d is string => Boolean(d)).sort() : [];
    const firstDay = days[0]; const lastDay = days[days.length - 1];
    const period = firstDay ? (monthLabel(firstDay) === monthLabel(lastDay) ? monthLabel(firstDay) : `${monthLabel(firstDay)} – ${monthLabel(lastDay)}`) : '';
    if (period) subtitle.push(period);

    // ── the outcome, and which side of it the story follows ──
    const outcome = shape.outcome;
    const yesText = outcome ? yesNoLabel(outcome, true) : '';
    const { badIsYes, focusWords } = outcome ? outcomeFocus(outcome) : { badIsYes: true, focusWords: '' };
    const isFocus = (row: Record<string, any>) => {
        const value = String(row[outcome!] ?? '');
        const yes = value === yesText || /^(1|true|yes|y|t)$/i.test(value);
        return badIsYes ? yes : !yes && !isBlank(row[outcome!]);
    };
    const outcomeRows = outcome ? rows.filter(row => !isBlank(row[outcome])) : [];
    const overallHits = outcomeRows.filter(isFocus).length;
    const overall = outcomeRows.length ? overallHits / outcomeRows.length : 0;
    const rateKey = focusWords ? `${focusWords.replace(/['’]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase()}_pct` : 'share_pct';
    const rateLabel = `% that ${focusWords}`;
    const minGroup = Math.max(30, Math.round(n * 0.005));

    const ratesBy = (key: (row: Record<string, any>) => string | null): Rate[] => {
        const map = new Map<string, { n: number; hits: number }>();
        for (const row of outcomeRows) {
            const k = key(row);
            if (k === null) continue;
            const e = map.get(k) || { n: 0, hits: 0 };
            e.n++; if (isFocus(row)) e.hits++;
            map.set(k, e);
        }
        return [...map.entries()].map(([k, e]) => ({ key: k, n: e.n, hits: e.hits, rate: e.n ? e.hits / e.n : 0 }));
    };
    /** How much a factor separates the outcome: the average distance of its groups from the overall rate. */
    const spreadOf = (groups: Rate[]) => {
        const total = groups.reduce((s, g) => s + g.n, 0);
        return total ? groups.reduce((s, g) => s + g.n * Math.abs(g.rate - overall), 0) / total : 0;
    };
    const rateChart = (groups: Rate[], xKey: string, yLabel: string, vis: StoryChart['vis'] = groups.length > 6 ? 'horizontalBar' : 'bar'): StoryChart => ({
        data: groups.map(g => ({ [xKey]: g.key, [rateKey]: round1(g.rate) })), xKey, yKey: rateKey, vis, yLabel, numberFormat: 'percent_points',
    });

    // ── 1. overview ──
    const entityId = shape.entityIds[0];
    const entityWord = entityId ? plural(idWord(entityId)) : '';
    const entities = entityId ? new Set(rows.map(row => row[entityId]).filter(v => !isBlank(v)).map(String)) : new Set<string>();
    const kpis: StoryKpi[] = [{ label: recordsCap, value: count(n) }];
    const overviewPoints: string[] = [];
    if (entityId && entities.size) {
        const perEntity = new Map<string, number>();
        for (const row of rows) { const k = row[entityId]; if (!isBlank(k)) perEntity.set(String(k), (perEntity.get(String(k)) || 0) + 1); }
        const repeat = [...perEntity.values()].filter(v => v > 1).length;
        kpis.push({ label: capital(entityWord), value: count(entities.size), note: `${(n / entities.size).toFixed(1)} ${records} each on average` });
        if (repeat) overviewPoints.push(`${pct(repeat / entities.size)} of ${entityWord} have more than one ${shape.recordWord}.`);
    }
    if (outcome) kpis.push({ label: capital(focusWords), value: pct(overall), note: `${count(overallHits)} of ${count(outcomeRows.length)} ${records}` });
    const attribute = shape.perRowNumbers[0];
    if (attribute) {
        const values = rows.map(row => asNumber(row[attribute])).filter((v): v is number => v !== null).sort((a, b) => a - b);
        if (values.length) kpis.push({ label: `Average ${numberLabel(attribute, shape.dayGaps)}`, value: (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1), note: `middle value ${values[Math.floor(values.length / 2)]}` });
    } else if (period) kpis.push({ label: 'Period', value: period });
    const headline = `${count(n)} ${records}${entities.size ? ` for ${count(entities.size)} ${entityWord}` : ''}${period ? `, ${period}` : ''}.${outcome ? ` ${pct(overall)} ${focusWords}.` : ''}`;
    overviewPoints.unshift(`There is nothing to add up in this file (no sales or amounts), so the story counts ${records}${outcome ? ` and compares the share that ${focusWords}` : ' and how they split'}.`);
    if (n < 30) overviewPoints.push(`There are only ${count(n)} rows, so treat every pattern here as a rough guide.`);
    findings.push({ id: 'overview', kind: 'overview', eyebrow: 'At a glance', headline, points: overviewPoints, kpis, score: 1000 });

    // ── 2. drivers of the outcome ──
    type Driver = { id: string; label: string; groups: Rate[]; spread: number; kind: 'yesno' | 'category' | 'bands' | 'weekday'; column: string; asked: boolean };
    const drivers: Driver[] = [];
    const mentions = (name: string) => question.toLowerCase().includes(human(name));
    const bandOf: Record<string, (row: Record<string, any>) => string | null> = {};
    const bandOrder: Record<string, (label: string) => number> = {};
    if (outcome) {
        for (const column of shape.yesNo.filter(c => c !== outcome)) {
            const groups = ratesBy(row => (isBlank(row[column]) ? null : String(row[column]))).filter(g => g.n >= minGroup);
            if (groups.length === 2) drivers.push({ id: column, label: flagSubject(column), groups, spread: spreadOf(groups), kind: 'yesno', column, asked: mentions(column) });
        }
        for (const column of shape.categories) {
            const all = ratesBy(row => (isBlank(row[column]) ? null : String(row[column]).trim()));
            if (all.length < 2 || all.length > 30) continue;
            const groups = all.filter(g => g.n >= minGroup);
            if (groups.length >= 2) drivers.push({ id: column, label: human(column), groups, spread: spreadOf(groups), kind: 'category', column, asked: mentions(column) });
        }
        for (const column of shape.perRowNumbers) {
            const values = rows.map(row => asNumber(row[column])).filter((v): v is number => v !== null);
            if (values.length < 50) continue;
            const isDays = Boolean(shape.dayGaps[column]) || /(day|diff|wait|lead|delay|gap)/i.test(column);
            const bands = bandsFor(column, values, isDays);
            bandOf[column] = row => { const v = asNumber(row[column]); return v === null ? null : bands.label(v); };
            bandOrder[column] = bands.order;
            const groups = ratesBy(bandOf[column]).filter(g => g.n >= minGroup).map(g => ({ ...g, order: bands.order(g.key) })).sort((a, b) => a.order! - b.order!);
            if (groups.length >= 2) drivers.push({ id: column, label: numberLabel(column, shape.dayGaps), groups, spread: spreadOf(groups), kind: 'bands', column, asked: mentions(column) });
        }
        if (eventDate) {
            const weekday = (row: Record<string, any>) => { const d = asDay(row[eventDate]); return d ? WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7] : null; };
            const groups = ratesBy(weekday).filter(g => g.n >= minGroup).map(g => ({ ...g, order: WEEKDAYS.indexOf(g.key) })).sort((a, b) => a.order! - b.order!);
            if (groups.length >= 3) drivers.push({ id: '__weekday', label: `day of the week`, groups, spread: spreadOf(groups), kind: 'weekday', column: eventDate, asked: /week ?day|day of (the )?week/i.test(question) });
        }
    }
    drivers.sort((a, b) => (Number(b.asked) - Number(a.asked)) || b.spread - a.spread);
    const flat: string[] = [];
    let shown = 0;
    for (const driver of drivers) {
        const sorted = [...driver.groups].sort((a, b) => b.rate - a.rate);
        const high = sorted[0]; const low = sorted[sorted.length - 1];
        const gap = high.rate - low.rate;
        if (gap < 0.02 && !driver.asked) { flat.push(driver.label); continue; }
        if (shown >= 4 && !driver.asked) continue;
        shown++;
        const pointsList: string[] = [];
        let headline: string;
        let chart: StoryChart;
        if (driver.kind === 'yesno') {
            const yes = driver.groups.find(g => g.key === yesNoLabel(driver.column, true)) || driver.groups[0];
            const no = driver.groups.find(g => g !== yes)!;
            headline = `${yes.key}: ${pct(yes.rate)} ${focusWords}, against ${pct(no.rate)} for ${no.key}.`;
            pointsList.push(`${count(yes.n)} ${records} are “${yes.key}” and ${count(no.n)} are “${no.key}”; the gap is ${points(yes.rate - no.rate)}.`);
            // Another factor that differs between the two groups and itself goes with the outcome.
            const other = drivers.find(d => d.kind === 'bands' && d.spread >= 0.02);
            if (other) {
                const mean = (key: string) => {
                    const list = rows.filter(row => String(row[driver.column] ?? '') === key).map(row => asNumber(row[other.column])).filter((v): v is number => v !== null);
                    return list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0;
                };
                const a = mean(yes.key); const b = mean(no.key);
                if (Math.min(a, b) >= 0 && Math.max(a, b) >= 1.4 * Math.max(0.5, Math.min(a, b))) {
                    pointsList.push(`Careful: “${yes.key}” ${records} also differ on ${other.label} (on average ${a.toFixed(1)} vs ${b.toFixed(1)}), which goes with the outcome too, so part of this gap may come from that rather than from ${lowerLabel(driver.label)}.`);
                }
            }
            chart = rateChart([yes, no], driver.column, `${capital(rateLabel)}: ${driver.label} or not`, 'bar');
        } else if (driver.kind === 'bands' || driver.kind === 'weekday') {
            const ordered = driver.groups;
            const first = ordered[0]; const last = ordered[ordered.length - 1];
            let ups = 0; let downs = 0;
            for (let i = 1; i < ordered.length; i++) { if (ordered[i].rate > ordered[i - 1].rate + 0.002) ups++; else if (ordered[i].rate < ordered[i - 1].rate - 0.002) downs++; }
            const steady = driver.kind === 'bands' && (ups === 0 || downs === 0 || Math.max(ups, downs) >= (ordered.length - 1) * 0.75);
            const isDays = /^days from/.test(driver.label) || / days$/.test(first.key) || first.key === 'same day';
            const at = (g: Rate) => (isDays ? (g.key === 'same day' ? 'when it is the same day' : `at ${g.key}`) : /^\d/.test(g.key) && /age/i.test(driver.column) ? `aged ${g.key}` : `at ${g.key}`);
            if (steady && Math.abs(last.rate - first.rate) >= 0.02) {
                const more = last.rate > first.rate;
                headline = isDays && shape.dayGaps[driver.column]
                    ? `The longer the wait from ${human(shape.dayGaps[driver.column].from)} to ${human(shape.dayGaps[driver.column].to)}, the ${more ? 'higher' : 'lower'} the share that ${focusWords}: ${pct(first.rate)} ${at(first)}, ${pct(last.rate)} ${at(last)}.`
                    : `The higher the ${driver.label}, the ${more ? 'higher' : 'lower'} the share that ${focusWords}: ${pct(first.rate)} ${at(first)}, ${pct(last.rate)} ${at(last)}.`;
            } else {
                headline = `By ${driver.label}, the highest share that ${focusWords} is ${at(high)} (${pct(high.rate)}), the lowest ${at(low)} (${pct(low.rate)}).`;
            }
            pointsList.push(`${ordered.map(g => `${g.key}: ${pct(g.rate)} of ${count(g.n)}`).join('; ')}.`);
            chart = rateChart(ordered, driver.kind === 'weekday' ? 'day' : driver.column, `${capital(rateLabel)} by ${driver.label}`, 'bar');
            if (driver.kind === 'weekday') chart.data = ordered.map(g => ({ day: g.key, [rateKey]: round1(g.rate) }));
        } else {
            headline = sorted.length === 2
                ? `${high.key}: ${pct(high.rate)} ${focusWords}, against ${pct(low.rate)} for ${low.key}.`
                : `By ${driver.label}, ${high.key} has the highest share that ${focusWords} (${pct(high.rate)}) and ${low.key} the lowest (${pct(low.rate)}).`;
            pointsList.push(`${sorted.slice(0, 4).map(g => `${g.key} ${pct(g.rate)} of ${count(g.n)}`).join(', ')}${sorted.length > 4 ? ', …' : ''}.`);
            const thin = ratesBy(row => (isBlank(row[driver.column]) ? null : String(row[driver.column]).trim())).filter(g => g.n < minGroup).length;
            if (thin) pointsList.push(`${thin} ${driver.label} value${thin === 1 ? '' : 's'} with fewer than ${minGroup} ${records} ${thin === 1 ? 'is' : 'are'} left out.`);
            chart = rateChart(sorted.slice(0, 12), driver.column, `${capital(rateLabel)} by ${driver.label}`);
        }
        findings.push({
            id: `driver_${driver.id}`, kind: driver.kind === 'bands' ? 'relationship' : 'breakdown', eyebrow: driver.kind === 'yesno' ? `${capital(driver.label)} or not` : `By ${driver.label}`,
            headline, points: pointsList, chart,
            ask: `Compare the % of ${records} that ${focusWords} by ${driver.kind === 'weekday' ? 'day of the week' : driver.label}`,
            score: 70 + Math.min(60, driver.spread * 600) + (driver.asked ? 60 : 0),
        });
    }
    if (flat.length && outcome) findings[0].points.push(`${capital(flat.slice(0, 4).join(', ').replace(/, ([^,]*)$/, ' and $1'))} make${flat.length === 1 ? 's' : ''} almost no difference to the share that ${focusWords} (within 2 points).`);

    // ── 3. where: a many-valued grouping (neighbourhood, clinic, doctor) ──
    const place = shape.categories
        .map(column => ({ column, distinct: new Set(rows.map(row => row[column]).filter(v => !isBlank(v)).map(String)).size }))
        .filter(c => c.distinct > 30 && c.distinct <= Math.max(500, n / 20))
        .sort((a, b) => Number(mentions(b.column)) - Number(mentions(a.column)) || a.distinct - b.distinct)[0];
    if (place) {
        const label = human(place.column);
        if (outcome) {
            const groups = ratesBy(row => (isBlank(row[place.column]) ? null : String(row[place.column]).trim())).filter(g => g.n >= Math.max(minGroup, 50)).sort((a, b) => b.rate - a.rate);
            if (groups.length >= 5) {
                const top = groups[0]; const bottom = groups[groups.length - 1];
                findings.push({
                    id: 'where', kind: 'concentration', eyebrow: `By ${label}`,
                    headline: `${top.key} has the highest share that ${focusWords}: ${pct(top.rate)} of ${count(top.n)} ${records}, against ${pct(bottom.rate)} in ${bottom.key} and ${pct(overall)} overall.`,
                    points: [
                        `Next highest: ${groups.slice(1, 4).map(g => `${g.key} ${pct(g.rate)}`).join(', ')}.`,
                        `Only ${label} values with at least ${Math.max(minGroup, 50)} ${records} are compared (${groups.length} of ${place.distinct}), so one-off rows can't top the list.`,
                    ],
                    chart: rateChart(groups.slice(0, 10), place.column, `${capital(rateLabel)} — highest 10 ${plural(label)}`, 'horizontalBar'),
                    ask: `Which ${plural(label)} have the highest % of ${records} that ${focusWords}?`,
                    score: 80 + Math.min(40, (top.rate - bottom.rate) * 100),
                });
            }
        } else {
            const counts = new Map<string, number>();
            for (const row of rows) { const k = row[place.column]; if (!isBlank(k)) counts.set(String(k).trim(), (counts.get(String(k).trim()) || 0) + 1); }
            const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            const k = Math.max(1, Math.round(ranked.length * 0.2));
            const share = ranked.slice(0, k).reduce((s, [, v]) => s + v, 0) / n;
            findings.push({
                id: 'where', kind: 'concentration', eyebrow: `By ${label}`,
                headline: `${ranked[0][0]} has the most ${records} (${count(ranked[0][1])}, ${pct(ranked[0][1] / n)}); the top ${k} of ${count(ranked.length)} ${plural(label)} have ${pct(share)} of them.`,
                points: [`Next: ${ranked.slice(1, 4).map(([key, v]) => `${key} ${count(v)}`).join(', ')}.`],
                chart: { data: ranked.slice(0, 10).map(([key, v]) => ({ [place.column]: key, [records]: v })), xKey: place.column, yKey: records, vis: 'horizontalBar', yLabel: `${recordsCap} — top 10 ${plural(label)}`, numberFormat: 'auto' },
                ask: `Top 10 ${plural(label)} by number of ${records}`,
                score: 75,
            });
        }
    }

    // ── 4. repeats: do a few people account for many bad outcomes? ──
    if (outcome && entityId && entities.size && entities.size < n * 0.95) {
        const byEntity = new Map<string, number>();
        for (const row of outcomeRows) if (isFocus(row)) { const k = String(row[entityId] ?? ''); if (k) byEntity.set(k, (byEntity.get(k) || 0) + 1); }
        const repeaters = [...byEntity.values()].filter(v => v >= 2);
        const fromRepeaters = repeaters.reduce((s, v) => s + v, 0);
        if (overallHits >= 50 && repeaters.length) {
            findings.push({
                id: 'repeats', kind: 'movers', eyebrow: `Repeat ${entityWord}`,
                headline: `${count(repeaters.length)} ${entityWord} ${focusWords} two or more times; between them they account for ${pct(fromRepeaters / overallHits)} of the ${count(overallHits)} ${records} that ${focusWords}.`,
                points: [`That is ${pct(repeaters.length / entities.size)} of ${entityWord}${fromRepeaters / overallHits >= 0.2 ? ' — a short list worth following up' : ''}.`],
                chart: {
                    data: ['1', '2', '3', '4+'].map(times => ({ times: `${times} time${times === '1' ? '' : 's'}`, [entityWord]: [...byEntity.values()].filter(v => (times === '4+' ? v >= 4 : v === Number(times))).length })),
                    xKey: 'times', yKey: entityWord, vis: 'bar', yLabel: `${capital(entityWord)} by how many times they ${focusWords}`, numberFormat: 'auto',
                },
                ask: `Which ${entityWord} ${focusWords} most often?`,
                score: 60 + Math.min(40, (fromRepeaters / overallHits) * 100),
            });
        }
    }

    // ── 5. mix: how common each yes/no answer is ──
    const flags = shape.yesNo.filter(c => c !== outcome);
    if (flags.length >= 2) {
        const shares = flags.map(column => {
            const filled = rows.filter(row => !isBlank(row[column]));
            const yes = filled.filter(row => String(row[column]) === yesNoLabel(column, true) || /^(1|true|yes|y|t)$/i.test(String(row[column]))).length;
            return { key: capital(flagSubject(column)), rate: filled.length ? yes / filled.length : 0, n: filled.length };
        }).sort((a, b) => b.rate - a.rate);
        const categoryMix = shape.categories.map(column => {
            const counts = new Map<string, number>();
            for (const row of rows) { const k = row[column]; if (!isBlank(k)) counts.set(String(k).trim(), (counts.get(String(k).trim()) || 0) + 1); }
            return { column, counts: [...counts.entries()].sort((a, b) => b[1] - a[1]) };
        }).filter(c => c.counts.length >= 2 && c.counts.length <= 6);
        findings.push({
            id: 'mix', kind: 'contrast', eyebrow: 'How common',
            headline: `${shares[0].key} is the most common (${pct(shares[0].rate)} of ${records}); ${lowerLabel(shares[shares.length - 1].key)} the least (${pct(shares[shares.length - 1].rate)}).`,
            points: [
                `${shares.map(s => `${s.key} ${pct(s.rate)}`).join(', ')}.`,
                ...categoryMix.slice(0, 2).map(c => `By ${human(c.column)}: ${c.counts.map(([key, v]) => `${key} ${pct(v / n)}`).join(', ')}.`),
            ],
            chart: { data: shares.map(s => ({ answer: s.key, share_pct: round1(s.rate) })), xKey: 'answer', yKey: 'share_pct', vis: shares.length > 6 ? 'horizontalBar' : 'bar', yLabel: `% of ${records} with each`, numberFormat: 'percent_points' },
            score: 55,
        });
    }

    // ── 6. trend over time ──
    if (eventDate && firstDay) {
        const spanDays = (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000;
        const monthly = spanDays >= 90;
        if (spanDays >= 42) {
            const keyOf = (day: string) => {
                if (monthly) return `${day.slice(0, 7)}-01`;
                const date = new Date(`${day}T00:00:00Z`);
                date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
                return date.toISOString().slice(0, 10);
            };
            const map = new Map<string, { n: number; hits: number }>();
            for (const row of rows) {
                const day = asDay(row[eventDate]);
                if (!day) continue;
                const k = keyOf(day);
                const e = map.get(k) || { n: 0, hits: 0 };
                e.n++; if (outcome && !isBlank(row[outcome]) && isFocus(row)) e.hits++;
                map.set(k, e);
            }
            const series = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, e]) => ({ key, ...e, rate: e.n ? e.hits / e.n : 0 }));
            // A last period with only a few days in it is left out of the comparison.
            const complete = series.length > 3 && series[series.length - 1].n < 0.5 * (series.slice(0, -1).reduce((s, p) => s + p.n, 0) / (series.length - 1)) ? series.slice(0, -1) : series;
            if (complete.length >= 3) {
                const busiest = complete.reduce((b, p) => (p.n > b.n ? p : b), complete[0]);
                const grainWord = monthly ? 'month' : 'week';
                const when = (key: string) => (monthly ? monthLabel(key) : `week of ${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`);
                const pointsList = [`Busiest ${grainWord}: ${when(busiest.key)} with ${count(busiest.n)} ${records}.`];
                if (outcome) {
                    const hi = complete.reduce((b, p) => (p.rate > b.rate ? p : b), complete[0]);
                    const lo = complete.reduce((b, p) => (p.rate < b.rate ? p : b), complete[0]);
                    pointsList.push(`The share that ${focusWords} ran from ${pct(lo.rate)} (${when(lo.key)}) to ${pct(hi.rate)} (${when(hi.key)}).`);
                }
                const half = Math.floor(complete.length / 2);
                const early = complete.slice(0, half).reduce((s, p) => s + p.n, 0) / half;
                const late = complete.slice(-half).reduce((s, p) => s + p.n, 0) / half;
                const change = early ? (late - early) / early : 0;
                findings.push({
                    id: 'trend', kind: 'trend', eyebrow: 'Over time',
                    headline: Math.abs(change) < 0.05
                        ? `About ${count(late)} ${records} a ${grainWord}, steady across the period.`
                        : `${recordsCap} ${change > 0 ? 'grew' : 'fell'} ${pct(Math.abs(change))} from the first half of the period to the second (about ${count(early)} to ${count(late)} a ${grainWord}).`,
                    points: pointsList,
                    chart: { data: complete.map(p => ({ period: p.key, [records]: p.n })), xKey: 'period', yKey: records, vis: complete.length > 8 ? 'area' : 'bar', yLabel: `${recordsCap} by ${grainWord}`, numberFormat: 'auto' },
                    ask: `Show the number of ${records}${outcome ? ` and the % that ${focusWords}` : ''} by ${grainWord}`,
                    score: 65 + Math.min(30, Math.abs(change) * 60),
                });
            }
        }
    }

    // ── 7. no outcome: averages of a number by the main category ──
    if (!outcome && attribute) {
        const category = shape.categories.find(c => { const d = new Set(rows.map(row => row[c]).filter(v => !isBlank(v))).size; return d >= 2 && d <= 12; });
        if (category) {
            const map = new Map<string, { s: number; n: number }>();
            for (const row of rows) { const k = row[category]; const v = asNumber(row[attribute]); if (isBlank(k) || v === null) continue; const e = map.get(String(k)) || { s: 0, n: 0 }; e.s += v; e.n++; map.set(String(k), e); }
            const groups = [...map.entries()].filter(([, e]) => e.n >= 3).map(([key, e]) => ({ key, avg: e.s / e.n, n: e.n })).sort((a, b) => b.avg - a.avg);
            if (groups.length >= 2) {
                const label = numberLabel(attribute, shape.dayGaps);
                findings.push({
                    id: 'attribute', kind: 'breakdown', eyebrow: `${capital(label)} by ${human(category)}`,
                    headline: `${groups[0].key} has the highest average ${label} (${groups[0].avg.toFixed(1)}), ${groups[groups.length - 1].key} the lowest (${groups[groups.length - 1].avg.toFixed(1)}).`,
                    points: [`${groups.map(g => `${g.key} ${g.avg.toFixed(1)} (${count(g.n)} ${records})`).join(', ')}.`],
                    chart: { data: groups.map(g => ({ [category]: g.key, [`avg_${attribute}`]: Math.round(g.avg * 10) / 10 })), xKey: category, yKey: `avg_${attribute}`, vis: groups.length > 6 ? 'horizontalBar' : 'bar', yLabel: `Average ${label} by ${human(category)}`, numberFormat: 'auto' },
                    ask: `Show average ${label} by ${human(category)}`,
                    score: 70,
                });
            }
        }
    }

    // ── 8. no outcome: how the main categories split ──
    if (!outcome) {
        for (const column of shape.categories.slice(0, 6)) {
            const counts = new Map<string, number>();
            for (const row of rows) { const k = row[column]; if (!isBlank(k)) counts.set(String(k).trim(), (counts.get(String(k).trim()) || 0) + 1); }
            const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            if (ranked.length < 2 || ranked.length > 12) continue;
            findings.push({
                id: `split_${column}`, kind: 'breakdown', eyebrow: `By ${human(column)}`,
                headline: `${ranked[0][0]} is the largest group: ${pct(ranked[0][1] / n)} of ${records} (${count(ranked[0][1])}).`,
                points: [`${ranked.slice(0, 5).map(([key, v]) => `${key} ${pct(v / n)}`).join(', ')}.`],
                chart: { data: ranked.map(([key, v]) => ({ [column]: key, [records]: v })), xKey: column, yKey: records, vis: ranked.length <= 5 ? 'doughnut' : 'bar', yLabel: `${recordsCap} by ${human(column)}`, numberFormat: 'auto' },
                ask: `How many ${records} are there by ${human(column)}?`,
                score: 50 + (1 - ranked[ranked.length - 1][1] / ranked[0][1]) * 30,
            });
        }
    }

    return { findings, subtitle, lead: recordsCap };
}
