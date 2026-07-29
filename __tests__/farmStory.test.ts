import { describe, it, expect } from 'vitest';
import {
  SALES, CHAPTERS, PRODUCTS, LANE_INFO, runQuery, formatMoney,
  type GAFSLane,
} from '../components/game/farmStory';
import { sceneFrameCount } from '../components/game/FarmScenes';

const revenue = (rows = SALES) => rows.reduce((s, r) => s + r.revenue, 0);

describe('Sam\'s farm dataset', () => {
  it('has a coherent year of sales', () => {
    expect(SALES.length).toBe(66);
    expect(revenue()).toBe(12163);
    expect(new Set(SALES.map(r => r.product)).size).toBe(PRODUCTS.length);
    expect(SALES.every(r => r.revenue > 0 && r.quantity > 0)).toBe(true);
    expect(SALES.every(r => r.month >= 1 && r.month <= 12)).toBe(true);
  });

  it('maps every month to the right season', () => {
    const winterMonths = new Set(SALES.filter(r => r.season === 'Winter').map(r => r.month));
    expect([...winterMonths].sort((a, b) => a - b)).toEqual([1, 2, 12]);
    const summerMonths = new Set(SALES.filter(r => r.season === 'Summer').map(r => r.month));
    expect([...summerMonths].sort((a, b) => a - b)).toEqual([6, 7, 8]);
  });
});

describe('the story beats hold', () => {
  // Chapter 2 only teaches anything if the two measures genuinely disagree.
  it('chapter 2: money and volume crown different winners', () => {
    const byMoney = runQuery({ groupBy: 'product', measure: 'revenue', sort: 'desc' });
    const byVolume = runQuery({ groupBy: 'product', measure: 'quantity', sort: 'desc' });

    expect(byMoney[0].label).toBe('Honey');
    expect(byVolume[0].label).toBe('Potatoes');

    // The numbers quoted in the outcome copy.
    expect(byVolume.find(r => r.label === 'Potatoes')!.value).toBe(1010);
    expect(byMoney.findIndex(r => r.label === 'Potatoes')).toBe(3);
    expect(byVolume.findIndex(r => r.label === 'Honey')).toBe(5);

    // Sweetcorn is the whole lesson: second by volume, last by money.
    expect(byVolume.findIndex(r => r.label === 'Sweetcorn')).toBe(1);
    expect(byMoney[byMoney.length - 1].label).toBe('Sweetcorn');
    expect(byVolume.find(r => r.label === 'Sweetcorn')!.value).toBe(750);
    expect(byMoney.find(r => r.label === 'Sweetcorn')!.value).toBe(600);
  });

  it('chapter 3: winter is three products and £1,141.50', () => {
    const winter = runQuery({
      groupBy: 'product', measure: 'revenue',
      filter: { label: 'winter', test: r => r.season === 'Winter' }, sort: 'desc',
    });
    expect(winter.map(r => r.label)).toEqual(['Eggs', 'Strawberry jam', 'Potatoes']);
    expect(winter[0].value).toBe(450);
    expect(revenue(SALES.filter(r => r.season === 'Winter'))).toBe(1141.5);
  });

  it('chapter 4: the top five fill the van with £9,421', () => {
    const top5 = runQuery({ groupBy: 'product', measure: 'revenue', sort: 'desc', limit: 5 });
    expect(top5.map(r => r.label)).toEqual(['Honey', 'Eggs', 'Strawberries', 'Potatoes', 'Tomatoes']);
    expect(top5.reduce((s, r) => s + r.value, 0)).toBe(9421);
    expect(top5.map(r => r.label)).not.toContain('Sweetcorn');
  });

  it('chapter 5: the cafés are a honey business', () => {
    const cafe = runQuery({
      groupBy: 'product', measure: 'revenue',
      filter: { label: 'café', test: r => r.channel === 'Café order' }, sort: 'desc', limit: 3,
    });
    expect(cafe.map(r => r.label)).toEqual(['Honey', 'Eggs', 'Strawberries']);
    expect(cafe.map(r => r.value)).toEqual([600, 360, 294]);
    expect(revenue(SALES.filter(r => r.channel === 'Café order'))).toBe(1371);
  });

  it('chapter 6: the year has a hole in it', () => {
    const months = runQuery({ groupBy: 'month', measure: 'revenue', sort: 'chronological' });
    expect(months.map(r => r.label)).toEqual(
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    );
    expect(months.find(r => r.label === 'Feb')!.value).toBe(240);
    expect(months.find(r => r.label === 'Aug')!.value).toBe(2466);

    const peak = months.filter(m => ['Jun', 'Jul', 'Aug', 'Sep'].includes(m.label))
      .reduce((s, r) => s + r.value, 0);
    expect(peak).toBe(8354);
    // "sixty-nine pence of every pound"
    expect(Math.round((peak / revenue()) * 100)).toBe(69);
  });
});

describe('runQuery', () => {
  it('sorts ascending, descending and chronologically', () => {
    const desc = runQuery({ groupBy: 'product', measure: 'revenue', sort: 'desc' });
    const asc = runQuery({ groupBy: 'product', measure: 'revenue', sort: 'asc' });
    expect(asc.map(r => r.label)).toEqual([...desc.map(r => r.label)].reverse());
  });

  it('applies the filter before totalling, not after', () => {
    const filtered = runQuery({
      groupBy: 'product', measure: 'revenue',
      filter: { label: 'market', test: r => r.channel === 'Market stall' }, sort: 'desc',
    });
    const unfiltered = runQuery({ groupBy: 'product', measure: 'revenue', sort: 'desc' });
    expect(filtered.find(r => r.label === 'Honey')!.value).toBe(1800);
    expect(unfiltered.find(r => r.label === 'Honey')!.value).toBe(2400);
  });

  it('only reports a unit when the group has exactly one', () => {
    const byProduct = runQuery({ groupBy: 'product', measure: 'quantity', sort: 'desc' });
    expect(byProduct.find(r => r.label === 'Honey')!.unit).toBe('jars');
    // A category mixes kg with cobs, so there is no honest unit to show.
    const byCategory = runQuery({ groupBy: 'category', measure: 'quantity', sort: 'desc' });
    expect(byCategory.find(r => r.label === 'Vegetable')!.unit).toBeUndefined();
  });

  it('respects the limit', () => {
    expect(runQuery({ groupBy: 'product', measure: 'revenue', sort: 'desc', limit: 3 })).toHaveLength(3);
  });
});

describe('chapter integrity', () => {
  it('numbers the chapters in order', () => {
    expect(CHAPTERS.map(c => c.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('introduces the lanes cumulatively and ends with all four', () => {
    expect(CHAPTERS[0].lanes).toEqual(['G']);
    expect(CHAPTERS[1].lanes).toEqual(['G', 'A']);
    expect(CHAPTERS[2].lanes).toEqual(['G', 'A', 'F']);
    expect(CHAPTERS[CHAPTERS.length - 1].lanes).toEqual(['G', 'A', 'F', 'S']);

    for (let i = 1; i < CHAPTERS.length; i++) {
      const prev = new Set(CHAPTERS[i - 1].lanes);
      // A lane never disappears once it has been taught.
      expect(CHAPTERS[i].lanes.length).toBeGreaterThanOrEqual(prev.size);
    }
  });

  it('gives every active lane exactly one right answer and an explanation', () => {
    for (const chapter of CHAPTERS) {
      for (const lane of chapter.lanes) {
        const correct = chapter.chips.filter(c => c.lane === lane && c.correct);
        expect(correct, `chapter ${chapter.id} lane ${lane}`).toHaveLength(1);
        expect(chapter.explanation[lane], `chapter ${chapter.id} lane ${lane} explanation`).toBeTruthy();
      }
    }
  });

  it('never offers a chip for a lane the chapter is not playing', () => {
    for (const chapter of CHAPTERS) {
      const active = new Set<GAFSLane>(chapter.lanes);
      for (const chip of chapter.chips) {
        expect(active.has(chip.lane), `chapter ${chapter.id} chip "${chip.label}"`).toBe(true);
      }
    }
  });

  it('explains every wrong answer rather than just rejecting it', () => {
    for (const chapter of CHAPTERS) {
      for (const chip of chapter.chips.filter(c => !c.correct)) {
        expect(chip.whyNot, `chapter ${chapter.id} chip "${chip.label}"`).toBeTruthy();
      }
    }
  });

  it('uses unique chip ids so placement cannot collide', () => {
    for (const chapter of CHAPTERS) {
      const ids = chapter.chips.map(c => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('gives every chapter a scene, a quote, an outcome and a builder bridge', () => {
    for (const chapter of CHAPTERS) {
      expect(chapter.beats.length).toBeGreaterThanOrEqual(2);
      expect(chapter.quote.length).toBeGreaterThan(10);
      expect(chapter.outcome.length).toBeGreaterThanOrEqual(2);
      expect(chapter.builderBridge.length).toBeGreaterThan(20);
      expect(chapter.teaches.split(' ').length).toBeLessThanOrEqual(6);
    }
  });

  // Story mode reveals one beat at a time over the scene, so a beat that
  // runs long stops being a caption and becomes the wall of text again.
  it('keeps every beat short enough to read in one breath', () => {
    for (const chapter of CHAPTERS) {
      expect(chapter.beats.length, `chapter ${chapter.id} beat count`).toBeLessThanOrEqual(4);
      for (const line of chapter.beats) {
        expect(line.length, `chapter ${chapter.id}: "${line}"`).toBeLessThanOrEqual(90);
      }
      // The payoff prose is read at rest, so it gets a little more room.
      for (const line of chapter.outcome) {
        expect(line.length, `chapter ${chapter.id} outcome: "${line}"`).toBeLessThanOrEqual(120);
      }
      expect(chapter.task.length, `chapter ${chapter.id} task`).toBeLessThanOrEqual(120);
    }
  });

  // This is a teaching game for people who do not work with data. Long
  // sentences and long answer buttons are the fastest way to lose them.
  it('keeps the language plain', () => {
    for (const chapter of CHAPTERS) {
      for (const line of [...chapter.beats, ...chapter.outcome, chapter.task]) {
        for (const sentence of line.split(/(?<=[.?!])\s+/)) {
          const words = sentence.trim().split(/\s+/).filter(Boolean).length;
          expect(words, `chapter ${chapter.id}: "${sentence}"`).toBeLessThanOrEqual(20);
        }
      }
      for (const chip of chapter.chips) {
        // An answer button has to be readable at a glance.
        expect(chip.label.length, `chapter ${chapter.id} chip "${chip.label}"`).toBeLessThanOrEqual(40);
        if (chip.whyNot) {
          expect(chip.whyNot.length, `chapter ${chapter.id} whyNot for "${chip.label}"`)
            .toBeLessThanOrEqual(110);
        }
      }
    }
  });

  // Chapter 1 is the first thing a beginner sees. No chart has been drawn
  // yet, so it cannot ask which "bar" something should be — grouping is
  // explained as sorting into piles, and the chart arrives in chapter 2
  // once there are numbers to draw.
  it('does not mention charts before one has been shown', () => {
    const first = CHAPTERS[0];
    const copy = [
      first.task,
      ...first.beats,
      ...first.outcome,
      ...Object.values(first.explanation),
      ...first.chips.flatMap(c => [c.label, c.whyNot ?? '']),
      first.payoff.caption,
    ].join(' ').toLowerCase();

    for (const word of ['bar', 'chart', 'axis', 'plot', 'graph']) {
      expect(copy, `chapter 1 mentions "${word}" before any chart exists`)
        .not.toMatch(new RegExp(`\\b${word}s?\\b`));
    }

    // And the chapter that does introduce the chart should say so.
    expect(`${CHAPTERS[1].task} ${CHAPTERS[1].payoff.caption}`.toLowerCase()).toContain('chart');
  });

  it('gives every GAFS step a concrete example, not just a definition', () => {
    for (const lane of ['G', 'A', 'F', 'S'] as GAFSLane[]) {
      expect(LANE_INFO[lane].plain, `${lane} plain example`).toMatch(/^e\.g\. /);
      expect(LANE_INFO[lane].asks.split(' ').length, `${lane} question`).toBeLessThanOrEqual(5);
    }
  });

  // Every beat gets its own staging. If someone adds a line without drawing
  // the picture for it, that line would silently reuse the previous frame.
  it('draws exactly one scene frame per beat', () => {
    for (const chapter of CHAPTERS) {
      expect(sceneFrameCount(chapter.scene), `chapter ${chapter.id} (${chapter.scene})`)
        .toBe(chapter.beats.length);
    }
  });

  // Every beat gets its own staging. If someone adds a line without drawing
  // the picture for it, that line would silently reuse the previous frame.
  it('draws exactly one scene frame per beat', () => {
    for (const chapter of CHAPTERS) {
      expect(sceneFrameCount(chapter.scene), `chapter ${chapter.id} (${chapter.scene})`)
        .toBe(chapter.beats.length);
    }
  });

  it('keeps the whole script lighter than the wall of text it replaced', () => {
    const words = CHAPTERS.reduce(
      (n, c) => n + [...c.beats, ...c.outcome, c.task, c.quote].join(' ').split(/\s+/).length,
      0,
    );
    expect(words).toBeLessThan(620);
  });

  it('runs every chapter payoff without error and returns rows', () => {
    for (const chapter of CHAPTERS) {
      const rows = runQuery(chapter.payoff.spec);
      expect(rows.length, `chapter ${chapter.id}`).toBeGreaterThan(0);
      if (chapter.payoff.compareWith) {
        expect(runQuery(chapter.payoff.compareWith).length).toBeGreaterThan(0);
      }
      if (chapter.payoff.spec.limit) {
        expect(rows.length).toBeLessThanOrEqual(chapter.payoff.spec.limit);
      }
    }
  });

  it('describes all four lanes', () => {
    expect(Object.keys(LANE_INFO)).toEqual(['G', 'A', 'F', 'S']);
  });
});

describe('formatMoney', () => {
  it('shows pence only when there are pence', () => {
    expect(formatMoney(1141.5)).toBe('£1,141.50');
    expect(formatMoney(12163)).toBe('£12,163');
    expect(formatMoney(600)).toBe('£600');
  });
});
