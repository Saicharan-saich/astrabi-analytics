// ═══════════════════════════════════════════════════════════════════
// SAM'S FARM — the story-mode dataset and script for the GAFS journey.
//
// Every number the player sees is computed from SALES below, so the
// charts in the story are the genuine answer to the question asked.
// ═══════════════════════════════════════════════════════════════════

export type GAFSLane = 'G' | 'A' | 'F' | 'S';

export type Channel = 'Market stall' | 'Café order' | 'Farm gate';
export type Season = 'Winter' | 'Spring' | 'Summer' | 'Autumn';

export interface SaleRow {
  month: number;
  monthName: string;
  season: Season;
  product: string;
  category: 'Fruit' | 'Vegetable' | 'Pantry';
  channel: Channel;
  quantity: number;
  unit: string;
  revenue: number;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SEASON_OF: Season[] = [
  'Winter', 'Winter', 'Spring', 'Spring', 'Spring', 'Summer',
  'Summer', 'Summer', 'Autumn', 'Autumn', 'Autumn', 'Winter',
];

const PRODUCT_META: Record<string, { category: SaleRow['category']; unit: string }> = {
  'Honey': { category: 'Pantry', unit: 'jars' },
  'Eggs': { category: 'Pantry', unit: 'dozen' },
  'Strawberry jam': { category: 'Pantry', unit: 'jars' },
  'Strawberries': { category: 'Fruit', unit: 'punnets' },
  'Blueberries': { category: 'Fruit', unit: 'punnets' },
  'Potatoes': { category: 'Vegetable', unit: 'kg' },
  'Tomatoes': { category: 'Vegetable', unit: 'kg' },
  'Sweetcorn': { category: 'Vegetable', unit: 'cobs' },
};

export const PRODUCTS = Object.keys(PRODUCT_META);

/** [product, month, channel, quantity, revenue] */
type RawSale = [string, number, Channel, number, number];

const RAW: RawSale[] = [
  // Eggs — the one thing that sells every single month.
  ['Eggs', 1, 'Market stall', 50, 150], ['Eggs', 2, 'Market stall', 50, 150],
  ['Eggs', 3, 'Market stall', 50, 150], ['Eggs', 4, 'Market stall', 50, 150],
  ['Eggs', 5, 'Market stall', 50, 150], ['Eggs', 6, 'Market stall', 50, 150],
  ['Eggs', 7, 'Market stall', 50, 150], ['Eggs', 8, 'Market stall', 50, 150],
  ['Eggs', 9, 'Market stall', 50, 150], ['Eggs', 10, 'Market stall', 50, 150],
  ['Eggs', 11, 'Market stall', 50, 150], ['Eggs', 12, 'Market stall', 50, 150],
  ['Eggs', 3, 'Café order', 15, 45], ['Eggs', 4, 'Café order', 15, 45],
  ['Eggs', 5, 'Café order', 15, 45], ['Eggs', 6, 'Café order', 15, 45],
  ['Eggs', 7, 'Café order', 15, 45], ['Eggs', 8, 'Café order', 15, 45],
  ['Eggs', 9, 'Café order', 15, 45], ['Eggs', 10, 'Café order', 15, 45],

  // Potatoes — heaviest thing he grows. February's field flooded.
  ['Potatoes', 1, 'Market stall', 70, 105], ['Potatoes', 3, 'Market stall', 70, 105],
  ['Potatoes', 4, 'Market stall', 70, 105], ['Potatoes', 5, 'Market stall', 70, 105],
  ['Potatoes', 6, 'Market stall', 70, 105], ['Potatoes', 7, 'Market stall', 70, 105],
  ['Potatoes', 8, 'Market stall', 70, 105], ['Potatoes', 9, 'Market stall', 70, 105],
  ['Potatoes', 10, 'Market stall', 70, 105], ['Potatoes', 11, 'Market stall', 70, 105],
  ['Potatoes', 12, 'Market stall', 70, 105],
  ['Potatoes', 9, 'Farm gate', 60, 90], ['Potatoes', 10, 'Farm gate', 60, 90],
  ['Potatoes', 11, 'Farm gate', 60, 90], ['Potatoes', 12, 'Farm gate', 60, 90],

  // Honey — four months a year, and worth more than anything else.
  ['Honey', 6, 'Market stall', 45, 360], ['Honey', 7, 'Market stall', 60, 480],
  ['Honey', 8, 'Market stall', 70, 560], ['Honey', 9, 'Market stall', 50, 400],
  ['Honey', 7, 'Café order', 25, 200], ['Honey', 8, 'Café order', 30, 240],
  ['Honey', 9, 'Café order', 20, 160],

  // Strawberries — the short, loud season.
  ['Strawberries', 5, 'Market stall', 90, 315], ['Strawberries', 6, 'Market stall', 180, 630],
  ['Strawberries', 7, 'Market stall', 170, 595], ['Strawberries', 8, 'Market stall', 76, 266],
  ['Strawberries', 6, 'Café order', 40, 140], ['Strawberries', 7, 'Café order', 44, 154],

  ['Tomatoes', 7, 'Market stall', 90, 252], ['Tomatoes', 8, 'Market stall', 150, 420],
  ['Tomatoes', 9, 'Market stall', 140, 392], ['Tomatoes', 10, 'Market stall', 65, 182],

  ['Blueberries', 6, 'Market stall', 70, 280], ['Blueberries', 7, 'Market stall', 110, 440],
  ['Blueberries', 8, 'Market stall', 90, 360],

  // Sweetcorn — enormous volume, almost no money.
  ['Sweetcorn', 8, 'Market stall', 400, 320], ['Sweetcorn', 9, 'Market stall', 350, 280],

  ['Strawberry jam', 1, 'Market stall', 22, 99], ['Strawberry jam', 2, 'Market stall', 20, 90],
  ['Strawberry jam', 3, 'Market stall', 18, 81], ['Strawberry jam', 9, 'Market stall', 30, 135],
  ['Strawberry jam', 10, 'Market stall', 35, 157.5], ['Strawberry jam', 11, 'Market stall', 40, 180],
  ['Strawberry jam', 12, 'Market stall', 45, 202.5],
  ['Strawberry jam', 10, 'Café order', 12, 54], ['Strawberry jam', 11, 'Café order', 14, 63],
];

export const SALES: SaleRow[] = RAW.map(([product, month, channel, quantity, revenue]) => ({
  month,
  monthName: MONTH_NAMES[month - 1],
  season: SEASON_OF[month - 1],
  product,
  category: PRODUCT_META[product].category,
  channel,
  quantity,
  unit: PRODUCT_META[product].unit,
  revenue,
}));

// ═══════════════════════════════════════════════════════════════════
// THE LITTLE QUERY ENGINE
// A deliberately tiny stand-in for what Question Builder does, so the
// story's charts are real results rather than hand-typed numbers.
// ═══════════════════════════════════════════════════════════════════

export type GroupKey = 'product' | 'month' | 'category' | 'channel';
export type Measure = 'revenue' | 'quantity';
export type SortMode = 'desc' | 'asc' | 'chronological';

export interface AnswerSpec {
  groupBy: GroupKey;
  measure: Measure;
  /** Named so the story can show the player exactly which rows survived. */
  filter?: { label: string; test: (row: SaleRow) => boolean };
  sort: SortMode;
  limit?: number;
}

export interface AnswerRow {
  label: string;
  value: number;
  /** Only meaningful when measuring quantity, where units differ per product. */
  unit?: string;
}

function groupValue(row: SaleRow, key: GroupKey): string {
  if (key === 'product') return row.product;
  if (key === 'month') return row.monthName;
  if (key === 'category') return row.category;
  return row.channel;
}

export function runQuery(spec: AnswerSpec, rows: SaleRow[] = SALES): AnswerRow[] {
  const kept = spec.filter ? rows.filter(spec.filter.test) : rows;

  const totals = new Map<string, { value: number; units: Set<string> }>();
  for (const row of kept) {
    const key = groupValue(row, spec.groupBy);
    const bucket = totals.get(key) ?? { value: 0, units: new Set<string>() };
    bucket.value += spec.measure === 'revenue' ? row.revenue : row.quantity;
    bucket.units.add(row.unit);
    totals.set(key, bucket);
  }

  let out: AnswerRow[] = [...totals.entries()].map(([label, bucket]) => ({
    label,
    value: Math.round(bucket.value * 100) / 100,
    unit: spec.measure === 'quantity' && bucket.units.size === 1 ? [...bucket.units][0] : undefined,
  }));

  if (spec.sort === 'chronological') {
    out.sort((a, b) => MONTH_NAMES.indexOf(a.label) - MONTH_NAMES.indexOf(b.label));
  } else if (spec.sort === 'asc') {
    out.sort((a, b) => a.value - b.value);
  } else {
    out.sort((a, b) => b.value - a.value);
  }

  return spec.limit ? out.slice(0, spec.limit) : out;
}

export function formatMoney(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const hasPence = Math.abs(rounded % 1) > 0.001;
  return '£' + rounded.toLocaleString('en-GB', {
    minimumFractionDigits: hasPence ? 2 : 0,
    maximumFractionDigits: hasPence ? 2 : 0,
  });
}

// ═══════════════════════════════════════════════════════════════════
// THE CHAPTERS
// ═══════════════════════════════════════════════════════════════════


export type SceneKey =
  | 'sunrise-farm' | 'market-stall' | 'winter-field'
  | 'loading-van' | 'cafe-delivery' | 'year-panorama';

export interface StoryChip {
  id: string;
  label: string;
  lane: GAFSLane;
  correct: boolean;
  /** Shown when the player places this chip in its lane and it is wrong. */
  whyNot?: string;
}

export interface Chapter {
  id: number;
  title: string;
  subtitle: string;
  scene: SceneKey;
  /** Which lanes the player fills in this chapter. Grows as the story goes on. */
  lanes: GAFSLane[];
  /** The new idea this chapter introduces, in six words or fewer. */
  teaches: string;
  /** One short line at a time, revealed over the scene. Never a wall of text. */
  beats: string[];
  quote: string;
  task: string;
  chips: StoryChip[];
  explanation: Partial<Record<GAFSLane, string>>;
  /** 'groups' shows the buckets with no measure yet — chapter 1 only. */
  payoff: { kind: 'bars' | 'columns' | 'groups' | 'compare'; spec: AnswerSpec; compareWith?: AnswerSpec; caption: string };
  outcome: string[];
  builderBridge: string;
}

export const FARMER = { name: 'Sam', full: 'Sam Whitfield', farm: 'Foxglove Farm' } as const;

export const CHAPTERS: Chapter[] = [
  {
    id: 1,
    title: 'The shoebox',
    subtitle: 'Grouping',
    scene: 'sunrise-farm',
    lanes: ['G'],
    teaches: 'Decide what you are comparing',
    beats: [
      'Sam has run Foxglove Farm for eleven years. Nine acres, twelve hens, one van that starts on the third try.',
      'He sells three ways: the Saturday market, the farm gate, and standing orders for two cafés.',
      'A year of sales sits in a shoebox under the counter.',
      'His sister asks which product actually makes money. Sam opens the box, and closes it again.',
    ],
    quote: 'I have all the numbers. I just can\'t see any of them.',
    task: 'The receipts are a spreadsheet now — one row per sale. Each bar on the chart has to stand for something. Pick what.',
    chips: [
      { id: 'c1-product', label: 'One bar per product', lane: 'G', correct: true },
      { id: 'c1-receipt', label: 'One bar per receipt', lane: 'G', correct: false, whyNot: 'That is 66 bars, one per sale. You are looking at the shoebox again, just prettier.' },
      { id: 'c1-day', label: 'One bar per market day', lane: 'G', correct: false, whyNot: 'A fine question, but a different one. That tells you which days were busy, not which products earn.' },
      { id: 'c1-farm', label: 'One bar for the whole farm', lane: 'G', correct: false, whyNot: 'One bar means one number. You learn the farm total and nothing about what is inside it.' },
    ],
    explanation: {
      G: 'Sam asked about products, so a product is what each bar stands for. Grouping is the first decision and it silently shapes every number after it.',
    },
    payoff: {
      kind: 'groups',
      spec: { groupBy: 'product', measure: 'revenue', sort: 'desc' },
      caption: 'Eight products. A year of receipts on one screen.',
    },
    outcome: [
      'Grouping on its own has not answered anything. Eight buckets, no numbers.',
      'That is the point. It gives you the shape of the answer. The next chapter gives you the answer.',
    ],
    builderBridge: 'In Question Builder this is the "by" dropdown. Pick Product, and you have done what Sam just did.',
  },

  {
    id: 2,
    title: 'Sacks and jars',
    subtitle: 'Aggregating',
    scene: 'market-stall',
    lanes: ['G', 'A'],
    teaches: 'Measuring the wrong thing lies',
    beats: [
      'Half six on a Saturday. The stall goes up in the dark.',
      'By nine the potatoes are moving in sacks. Sam has called them his bestseller for years.',
      'The honey sits at the back in a small pyramid. Some weeks he sells four jars.',
      'Same eight products as last chapter. The question is what you count.',
    ],
    quote: 'Potatoes are my bestseller. Ask anyone at that market.',
    task: 'Keep grouping by product. Now choose what to measure — and be careful, because these two choices disagree.',
    chips: [
      { id: 'c2-product', label: 'One bar per product', lane: 'G', correct: true },
      { id: 'c2-month', label: 'One bar per month', lane: 'G', correct: false, whyNot: 'Months arrive in chapter six. Sam is still asking about products.' },
      { id: 'c2-money', label: 'Add up the money taken', lane: 'A', correct: true },
      { id: 'c2-units', label: 'Add up the units sold', lane: 'A', correct: false, whyNot: 'This is the answer Sam already believes. It is also the one that has been misleading him.' },
      { id: 'c2-avg', label: 'Average sale size', lane: 'A', correct: false, whyNot: 'Useful later, but averages hide how often something sells. One big order would top this chart.' },
    ],
    explanation: {
      G: 'Unchanged from chapter one — still one bar per product.',
      A: 'Money is the only fair comparison here. Look at the units: kilos, jars, punnets, cobs. Adding those together is adding apples to eggs.',
    },
    payoff: {
      kind: 'compare',
      spec: { groupBy: 'product', measure: 'revenue', sort: 'desc' },
      compareWith: { groupBy: 'product', measure: 'quantity', sort: 'desc' },
      caption: 'Same grouping, same rows. Two measures, two different worlds.',
    },
    outcome: [
      'Potatoes really are the bestseller by volume: 1,010 kg. By money they come fourth.',
      'Honey is sixth by volume and first by money. And sweetcorn is second by volume and dead last by money — 750 cobs for £600.',
    ],
    builderBridge: 'In Question Builder this is the metric selector: Revenue or Quantity, then Sum. Switching it is one click, which is exactly why it is worth checking.',
  },

  {
    id: 3,
    title: 'The empty stall',
    subtitle: 'Filtering',
    scene: 'winter-field',
    lanes: ['G', 'A', 'F'],
    teaches: 'Cut to the rows that matter',
    beats: [
      'November. Rain sideways across the top field.',
      'By ten the table holds eggs, potatoes and a row of jam jars. That is it.',
      'Last chapter\'s chart is proud of honey and strawberries. Neither exists in January.',
    ],
    quote: 'Come January there is nothing on that table. What sells when nothing is growing?',
    task: 'Same grouping, same measure. Now cut the rows down to the part of the year Sam is worried about.',
    chips: [
      { id: 'c3-product', label: 'One bar per product', lane: 'G', correct: true },
      { id: 'c3-money', label: 'Add up the money taken', lane: 'A', correct: true },
      { id: 'c3-units', label: 'Add up the units sold', lane: 'A', correct: false, whyNot: 'Chapter two settled this. Kilos and jars do not add up together.' },
      { id: 'c3-winter', label: 'Winter months only', lane: 'F', correct: true },
      { id: 'c3-summer', label: 'Summer months only', lane: 'F', correct: false, whyNot: 'That answers the opposite question. Summer is the part Sam is not worried about.' },
      { id: 'c3-none', label: 'No filter, use the whole year', lane: 'F', correct: false, whyNot: 'This is the chart he already has, and the reason he is confused — twelve months of honey averaged into a January he never has.' },
    ],
    explanation: {
      G: 'Still products.',
      A: 'Still money.',
      F: 'Filtering throws away rows before anything is added up. June to September vanishes, and what is left is the truth about Sam\'s winter.',
    },
    payoff: {
      kind: 'bars',
      spec: {
        groupBy: 'product',
        measure: 'revenue',
        filter: { label: 'Season is Winter (Dec, Jan, Feb)', test: r => r.season === 'Winter' },
        sort: 'desc',
      },
      caption: 'Three products. That is the entire winter business.',
    },
    outcome: [
      'Five of the eight products disappear. Winter is eggs, jam and potatoes.',
      '£1,141 of a £12,163 year. Sam orders more jam jars in September and buys six more hens.',
    ],
    builderBridge: 'In Question Builder this is the filter row and the date range. Filters run before the totals, which is why the whole chart changes shape rather than just shrinking.',
  },

  {
    id: 4,
    title: 'What fits in the van',
    subtitle: 'Sorting',
    scene: 'loading-van',
    lanes: ['G', 'A', 'F', 'S'],
    teaches: 'Rank it, then cut the list',
    beats: [
      'The van holds five crates. Not six. He has tried six.',
      'Every Saturday at five in the morning he stands in the cold and guesses which five.',
      'This week he decides the night before, sitting down, with the year in front of him.',
    ],
    quote: 'Five crates. Tell me which five and I will never think about it again.',
    task: 'All four moves now. Group, measure, filter, and put the answer in an order that makes the decision for him.',
    chips: [
      { id: 'c4-product', label: 'One bar per product', lane: 'G', correct: true },
      { id: 'c4-money', label: 'Add up the money taken', lane: 'A', correct: true },
      { id: 'c4-none', label: 'No filter, use the whole year', lane: 'F', correct: true },
      { id: 'c4-winter', label: 'Winter months only', lane: 'F', correct: false, whyNot: 'Sam loads that van every Saturday all year, so the decision needs the whole year.' },
      { id: 'c4-top5', label: 'Biggest first, keep the top 5', lane: 'S', correct: true },
      { id: 'c4-small', label: 'Smallest first, keep the top 5', lane: 'S', correct: false, whyNot: 'That hands him the five worst products on the farm. Sort direction is not a detail.' },
      { id: 'c4-az', label: 'A to Z by name', lane: 'S', correct: false, whyNot: 'Alphabetical is a filing system, not an answer. Blueberries would make the van purely for starting with B.' },
    ],
    explanation: {
      G: 'Products.',
      A: 'Money.',
      F: 'No filter. The van goes out all year, so the whole year is the right scope.',
      S: 'Biggest-first turns a chart into a decision, and the limit of 5 matches the thing that is actually scarce: crate space.',
    },
    payoff: {
      kind: 'bars',
      spec: { groupBy: 'product', measure: 'revenue', sort: 'desc', limit: 5 },
      caption: 'The five crates, decided.',
    },
    outcome: [
      'Honey, eggs, strawberries, potatoes, tomatoes. Together, £9,421 of a £12,163 year.',
      'Sweetcorn does not make the van. It filled two crates and earned less than anything else on the farm.',
    ],
    builderBridge: 'In Question Builder this is the sort direction plus Top N. The limit box is the one people skip, and it is usually where the decision lives.',
  },

  {
    id: 5,
    title: 'The café order',
    subtitle: 'All four together',
    scene: 'cafe-delivery',
    lanes: ['G', 'A', 'F', 'S'],
    teaches: 'Filters cut on any column',
    beats: [
      'Thursday. The café on Bridge Street asks if he can supply more.',
      'Whatever he can spare, they say. Sam says yes before working out what that means.',
      'Stall, farm gate and café orders all sit in the same spreadsheet.',
    ],
    quote: 'They want more. More of what, though?',
    task: 'Same four moves. This time the filter has nothing to do with dates.',
    chips: [
      { id: 'c5-product', label: 'One bar per product', lane: 'G', correct: true },
      { id: 'c5-channel', label: 'One bar per sales channel', lane: 'G', correct: false, whyNot: 'That tells you cafés are worth £1,371 a year, and not one thing about what to send them.' },
      { id: 'c5-money', label: 'Add up the money taken', lane: 'A', correct: true },
      { id: 'c5-cafe', label: 'Café orders only', lane: 'F', correct: true },
      { id: 'c5-market', label: 'Market stall only', lane: 'F', correct: false, whyNot: 'Wrong channel. The market stall has different customers who want different things.' },
      { id: 'c5-top3', label: 'Biggest first, keep the top 3', lane: 'S', correct: true },
      { id: 'c5-all', label: 'Biggest first, keep everything', lane: 'S', correct: false, whyNot: 'Not wrong exactly, but he asked what to prioritise, and a list of everything is not a priority.' },
    ],
    explanation: {
      G: 'Products, because the café asked what to send.',
      A: 'Money.',
      F: 'The filter here is a category, not a date. Any column can be filtered, and this is the one that separates his three businesses.',
      S: 'Top 3, because he can realistically scale up three things and not eight.',
    },
    payoff: {
      kind: 'bars',
      spec: {
        groupBy: 'product',
        measure: 'revenue',
        filter: { label: 'Channel is Café order', test: r => r.channel === 'Café order' },
        sort: 'desc',
        limit: 3,
      },
      caption: 'What the cafés actually buy.',
    },
    outcome: [
      'Honey £600, eggs £360, strawberries £294. The cafés are quietly a honey business.',
      'The customer asking to buy more wants the thing he makes the most on. Sam adds four hives in the spring.',
    ],
    builderBridge: 'Filters are not limited to dates. Any column with a handful of repeated values can become one, and that is usually where the surprises are.',
  },

  {
    id: 6,
    title: 'The shape of the year',
    subtitle: 'When sorting must not sort',
    scene: 'year-panorama',
    lanes: ['G', 'A', 'F', 'S'],
    teaches: 'Time has its own order',
    beats: [
      'The bank wants a plan before it will lend for the hives.',
      'Not a story about honey. A plan, with months in it.',
      'Five questions about products. This one is not about products at all.',
    ],
    quote: 'They want to know when the money comes in. I have never actually looked.',
    task: 'Group by something new — and think hard about the sort. The obvious choice is the wrong one here.',
    chips: [
      { id: 'c6-month', label: 'One bar per month', lane: 'G', correct: true },
      { id: 'c6-product', label: 'One bar per product', lane: 'G', correct: false, whyNot: 'Products have been the answer five times running. This question is about when, so the grouping has to change.' },
      { id: 'c6-money', label: 'Add up the money taken', lane: 'A', correct: true },
      { id: 'c6-none', label: 'No filter, use the whole year', lane: 'F', correct: true },
      { id: 'c6-summer', label: 'Summer months only', lane: 'F', correct: false, whyNot: 'The empty months are the entire point of this chart. Filtering them out deletes the finding.' },
      { id: 'c6-time', label: 'January through to December', lane: 'S', correct: true },
      { id: 'c6-big', label: 'Biggest first', lane: 'S', correct: false, whyNot: 'This worked beautifully in chapter four and it destroys this chart. August next to July next to June tells you nothing about a year.' },
    ],
    explanation: {
      G: 'Month. The question asks when, so time becomes the thing you are comparing.',
      A: 'Money.',
      F: 'Nothing filtered. The thin months carry the message.',
      S: 'Chronological. When time is the grouping, sorting by size shuffles the calendar and throws away the only thing the chart had to say.',
    },
    payoff: {
      kind: 'columns',
      spec: { groupBy: 'month', measure: 'revenue', sort: 'chronological' },
      caption: 'Twelve months of Foxglove Farm, in order.',
    },
    outcome: [
      'February £240. August £2,466. The same farm, ten times the money.',
      'June to September is sixty-nine pence of every pound Sam earns. He takes this chart to the bank, hole and all.',
    ],
    builderBridge: 'Question Builder sorts by size by default, because most questions want that. When you group by a date, change it. It is the most common way a good chart gets ruined.',
  },
];

export const LANE_INFO: Record<GAFSLane, { letter: string; name: string; asks: string }> = {
  G: { letter: 'G', name: 'Grouping', asks: 'What am I comparing?' },
  A: { letter: 'A', name: 'Aggregating', asks: 'What am I measuring?' },
  F: { letter: 'F', name: 'Filtering', asks: 'Which rows count?' },
  S: { letter: 'S', name: 'Sorting', asks: 'What order, how many?' },
};
