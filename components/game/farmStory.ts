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
  'Eggs': { category: 'Pantry', unit: 'boxes' },
  'Strawberry jam': { category: 'Pantry', unit: 'jars' },
  'Strawberries': { category: 'Fruit', unit: 'boxes' },
  'Blueberries': { category: 'Fruit', unit: 'boxes' },
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
    title: 'What should I look at?',
    subtitle: 'Grouping',
    scene: 'sunrise-farm',
    lanes: ['G'],
    teaches: 'Split the sales up by product',
    beats: [
      'Sam owns a small farm. He sells 8 things: honey, eggs, jam, potatoes and more.',
      'He sells them in 3 places: the market, the farm gate, and 2 cafés.',
      'Every sale gets written on a slip of paper. A whole year of paper, in one box.',
      'His sister asks him: which product makes you the most money? Sam has no idea.',
    ],
    quote: 'I have all the numbers. I just cannot see them.',
    task: "All of Sam's sales are in one big pile. To compare products he needs smaller piles. What should each pile be?",
    chips: [
      { id: 'c1-product', label: 'By product', lane: 'G', correct: true },
      { id: 'c1-receipt', label: 'By each single sale', lane: 'G', correct: false, whyNot: 'That makes 66 piles of one slip each. Same mess as the box, just tidier.' },
      { id: 'c1-day', label: 'By market day', lane: 'G', correct: false, whyNot: 'That tells you which days were busy. Sam asked about products.' },
      { id: 'c1-farm', label: 'Do not split it at all', lane: 'G', correct: false, whyNot: 'One pile gives you one number for the whole farm, and nothing about products.' },
    ],
    explanation: {
      G: 'Sam asked about products, so he sorts the sales into one pile per product. Sorting rows into piles is all that grouping means.',
    },
    payoff: {
      kind: 'groups',
      spec: { groupBy: 'product', measure: 'revenue', sort: 'desc' },
      caption: '8 piles, one for each product. No numbers yet.',
    },
    outcome: [
      'The sales are now in 8 piles, one per product. There are still no numbers.',
      'Grouping only sorts things into piles. Chapter 2 puts a number on each pile.',
    ],
    builderBridge: 'In Question Builder this is the "by" box. Choose Product and it makes one pile per product.',
  },

  {
    id: 2,
    title: 'Money, or how many?',
    subtitle: 'Aggregating',
    scene: 'market-stall',
    lanes: ['G', 'A'],
    teaches: 'Add up money, not units',
    beats: [
      'Saturday market. The potatoes sell fast, in big heavy sacks.',
      'The honey sits at the back. Some weeks Sam sells 4 jars.',
      'He is sure potatoes are his best product.',
      'But "best" can mean two things: most sold, or most money.',
    ],
    quote: 'Potatoes are my bestseller. Ask anyone at the market.',
    task: 'Keep the 8 piles. Now pick a number to add up for each pile, and we can draw it as a chart.',
    chips: [
      { id: 'c2-product', label: 'By product', lane: 'G', correct: true },
      { id: 'c2-month', label: 'By month', lane: 'G', correct: false, whyNot: 'Months come in chapter 6. This question is still about products.' },
      { id: 'c2-money', label: 'Add up the money', lane: 'A', correct: true },
      { id: 'c2-units', label: 'Add up how many were sold', lane: 'A', correct: false, whyNot: 'This is what Sam already believes, and it is why he is wrong.' },
      { id: 'c2-avg', label: 'Take the average sale', lane: 'A', correct: false, whyNot: 'An average hides how often you sell. One big order would top the chart.' },
    ],
    explanation: {
      G: 'Same as chapter 1. One pile per product.',
      A: 'Money. You cannot add kg, jars and boxes together, because they are not the same thing. Money is the same for everything.',
    },
    payoff: {
      kind: 'compare',
      spec: { groupBy: 'product', measure: 'revenue', sort: 'desc' },
      compareWith: { groupBy: 'product', measure: 'quantity', sort: 'desc' },
      caption: 'Your first chart. One bar per pile — a longer bar means a bigger number.',
    },
    outcome: [
      'By units, potatoes win: 1,010 kg. By money they come 4th.',
      'Honey is 6th by units and 1st by money, at £2,400.',
      'Sweetcorn is 2nd by units and last by money: 750 cobs for only £600.',
    ],
    builderBridge: 'In Question Builder this is the metric box. Pick Revenue or Quantity, then Sum.',
  },

  {
    id: 3,
    title: 'What sells in winter?',
    subtitle: 'Filtering',
    scene: 'winter-field',
    lanes: ['G', 'A', 'F'],
    teaches: 'Keep only the rows you need',
    beats: [
      'It is November. Cold and wet, and the table is nearly empty.',
      'In winter Sam only has eggs, jam and potatoes to sell.',
      'But his chart still shows honey and strawberries. In January he has neither.',
    ],
    quote: 'In January there is nothing on my table. What actually sells then?',
    task: 'Same bars, same number. Now throw away the months you do not need.',
    chips: [
      { id: 'c3-product', label: 'By product', lane: 'G', correct: true },
      { id: 'c3-money', label: 'Add up the money', lane: 'A', correct: true },
      { id: 'c3-units', label: 'Add up how many were sold', lane: 'A', correct: false, whyNot: 'Chapter 2 settled this. You cannot add kg and jars together.' },
      { id: 'c3-winter', label: 'Only the winter months', lane: 'F', correct: true },
      { id: 'c3-summer', label: 'Only the summer months', lane: 'F', correct: false, whyNot: 'That is the opposite question. Summer is not the problem.' },
      { id: 'c3-none', label: 'Keep all 12 months', lane: 'F', correct: false, whyNot: 'This is the chart he already has. It mixes summer honey into a winter he never has.' },
    ],
    explanation: {
      G: 'Still split by product.',
      A: 'Still money.',
      F: 'A filter removes rows before anything is added up. Take out June to September and the answer changes completely.',
    },
    payoff: {
      kind: 'bars',
      spec: {
        groupBy: 'product',
        measure: 'revenue',
        filter: { label: 'Winter only (December, January, February)', test: r => r.season === 'Winter' },
        sort: 'desc',
      },
      caption: '3 products. That is the whole winter.',
    },
    outcome: [
      'Only 3 products are left: eggs £450, jam £392, potatoes £300.',
      'Winter brings in £1,141 of a £12,163 year. Sam buys 6 more hens.',
    ],
    builderBridge: 'In Question Builder this is the filter row and the date range. Filters run before the totals.',
  },

  {
    id: 4,
    title: 'Only 5 boxes fit',
    subtitle: 'Sorting',
    scene: 'loading-van',
    lanes: ['G', 'A', 'F', 'S'],
    teaches: 'Put the best ones on top',
    beats: [
      'The van fits 5 boxes. Not 6. Sam has tried 6.',
      'Every Saturday at 5am he guesses which 5 to take.',
      'This time he sits down and checks the numbers first.',
    ],
    quote: 'Just tell me which 5 to take.',
    task: 'All four steps now. Put the answer in an order that picks the 5 for him.',
    chips: [
      { id: 'c4-product', label: 'By product', lane: 'G', correct: true },
      { id: 'c4-money', label: 'Add up the money', lane: 'A', correct: true },
      { id: 'c4-none', label: 'Keep all 12 months', lane: 'F', correct: true },
      { id: 'c4-winter', label: 'Only the winter months', lane: 'F', correct: false, whyNot: 'He drives to market all year, so use the whole year.' },
      { id: 'c4-top5', label: 'Biggest first, keep the top 5', lane: 'S', correct: true },
      { id: 'c4-small', label: 'Smallest first, keep the top 5', lane: 'S', correct: false, whyNot: 'That gives him his 5 worst products.' },
      { id: 'c4-az', label: 'A to Z by name', lane: 'S', correct: false, whyNot: 'A to Z is not an answer. Blueberries would win just for starting with B.' },
    ],
    explanation: {
      G: 'Split by product.',
      A: 'Money.',
      F: 'No filter. He goes to market all year, so keep all 12 months.',
      S: 'Biggest first, then keep only 5. That turns a chart into a decision.',
    },
    payoff: {
      kind: 'bars',
      spec: { groupBy: 'product', measure: 'revenue', sort: 'desc', limit: 5 },
      caption: 'The 5 boxes, decided.',
    },
    outcome: [
      'Honey, eggs, strawberries, potatoes, tomatoes. Together, £9,421 of a £12,163 year.',
      'Sweetcorn does not fit. It filled 2 boxes and earned the least of anything on the farm.',
    ],
    builderBridge: 'In Question Builder this is the sort order plus Top N. Most people forget the Top N box.',
  },

  {
    id: 5,
    title: 'What do the cafés buy?',
    subtitle: 'All four steps',
    scene: 'cafe-delivery',
    lanes: ['G', 'A', 'F', 'S'],
    teaches: 'Filters work on any column',
    beats: [
      'A café asks Sam if he can send them more.',
      'He says yes. Then he thinks: more of what?',
      'Market, farm gate and café sales all sit in the same spreadsheet.',
    ],
    quote: 'They want more. More of what?',
    task: 'All four steps again. This time the filter has nothing to do with dates.',
    chips: [
      { id: 'c5-product', label: 'By product', lane: 'G', correct: true },
      { id: 'c5-channel', label: 'By where he sold it', lane: 'G', correct: false, whyNot: 'That tells you cafés are worth £1,371 a year. It does not tell you what to send them.' },
      { id: 'c5-money', label: 'Add up the money', lane: 'A', correct: true },
      { id: 'c5-cafe', label: 'Only café orders', lane: 'F', correct: true },
      { id: 'c5-market', label: 'Only market sales', lane: 'F', correct: false, whyNot: 'Wrong customers. People at the market buy different things.' },
      { id: 'c5-top3', label: 'Biggest first, keep the top 3', lane: 'S', correct: true },
      { id: 'c5-all', label: 'Biggest first, keep everything', lane: 'S', correct: false, whyNot: 'He asked what to focus on. A list of everything is not a focus.' },
    ],
    explanation: {
      G: 'Split by product, because the café asked what to send.',
      A: 'Money.',
      F: 'You can filter on any column, not just dates. Here we filter on where the sale happened.',
      S: 'Top 3, because he can grow 3 things, not 8.',
    },
    payoff: {
      kind: 'bars',
      spec: {
        groupBy: 'product',
        measure: 'revenue',
        filter: { label: 'Café orders only', test: r => r.channel === 'Café order' },
        sort: 'desc',
        limit: 3,
      },
      caption: 'What the cafés actually buy.',
    },
    outcome: [
      'Honey £600, eggs £360, strawberries £294.',
      'The cafés mainly want honey, which is also the product that earns him the most. Sam adds 4 beehives.',
    ],
    builderBridge: 'Filters are not only for dates. Any column with repeated values can be a filter.',
  },

  {
    id: 6,
    title: 'When does the money come in?',
    subtitle: 'Sorting by date',
    scene: 'year-panorama',
    lanes: ['G', 'A', 'F', 'S'],
    teaches: 'Keep months in date order',
    beats: [
      'The bank wants a plan before it will lend Sam money for the beehives.',
      'It wants to see months, not products.',
      'Same four steps as before. But one of them has to change.',
    ],
    quote: 'They want to know when the money comes in. I have never looked.',
    task: 'Split by month this time. And think about the order, because the usual one is wrong here.',
    chips: [
      { id: 'c6-month', label: 'By month', lane: 'G', correct: true },
      { id: 'c6-product', label: 'By product', lane: 'G', correct: false, whyNot: 'Products were the answer 5 times. This question asks when, so split by month.' },
      { id: 'c6-money', label: 'Add up the money', lane: 'A', correct: true },
      { id: 'c6-none', label: 'Keep all 12 months', lane: 'F', correct: true },
      { id: 'c6-summer', label: 'Only the summer months', lane: 'F', correct: false, whyNot: 'The empty months are the whole point. Removing them removes the answer.' },
      { id: 'c6-time', label: 'January to December', lane: 'S', correct: true },
      { id: 'c6-big', label: 'Biggest first', lane: 'S', correct: false, whyNot: 'This was right in chapter 4. Here it scrambles the calendar and hides the answer.' },
    ],
    explanation: {
      G: 'Month, because the question asks when.',
      A: 'Money.',
      F: 'No filter. The quiet months are the important part.',
      S: 'Date order. When the bars are months, putting the biggest first mixes up the calendar.',
    },
    payoff: {
      kind: 'columns',
      spec: { groupBy: 'month', measure: 'revenue', sort: 'chronological' },
      caption: '12 months of Foxglove Farm, in date order.',
    },
    outcome: [
      'February £240. August £2,466. The same farm, 10 times the money.',
      'June to September brings in 69p of every £1 Sam earns. He takes this chart to the bank.',
    ],
    builderBridge: 'Question Builder sorts by size by default. When you group by a date, switch it to date order.',
  },
];

export const LANE_INFO: Record<GAFSLane, { letter: string; name: string; asks: string; plain: string }> = {
  G: { letter: 'G', name: 'Grouping', asks: 'Split it up by what?', plain: 'e.g. by product' },
  A: { letter: 'A', name: 'Aggregating', asks: 'Which number?', plain: 'e.g. add up the money' },
  F: { letter: 'F', name: 'Filtering', asks: 'Which rows?', plain: 'e.g. winter months only' },
  S: { letter: 'S', name: 'Sorting', asks: 'In what order?', plain: 'e.g. biggest first, top 5' },
};
