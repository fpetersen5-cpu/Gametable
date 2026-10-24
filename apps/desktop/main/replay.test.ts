import { describe, expect, it } from 'vitest';
import { RandomBot, runMatch, type Seat } from '@gametable/engine';
import { mafia } from '@gametable/games-mafia';
import { projectSeatViews, ReplayIncompatibleError } from './replay.js';
import type { ReplayBundle } from '../shared/api.js';

describe('seat perspective replay', () => {
  it('rebuilds one view per action from the seat that made the decision', async () => {
    const seats: Seat[] = Array.from({ length: 7 }, (_, index) => ({
      id: `s${index + 1}`,
      name: `Seat ${index + 1}`,
      kind: 'bot',
    }));
    const bots = new Map(seats.map((seat, index) => [seat.id, new RandomBot(index + 1)]));
    const result = await runMatch(mafia, seats, bots, { seed: 3, maxActions: 600 });
    const bundle = {
      seed: result.seed,
      seats,
      options: {},
      events: result.events,
    } as unknown as ReplayBundle;

    const setup = mafia.setup({ seed: result.seed, seats, options: {} });
    const mafiaSeat = seats.find((seat) => mafia.roleOf?.(setup, seat.id) === 'mafia');
    const villager = seats.find((seat) => mafia.roleOf?.(setup, seat.id) === 'villager');
    expect(mafiaSeat).toBeDefined();
    expect(villager).toBeDefined();

    for (const seat of seats) {
      const views = projectSeatViews(mafia, bundle, seat.id);
      expect(views).toHaveLength(result.events.length + 1);
      const data = views[0]?.data as { yourRole?: string };
      expect(data.yourRole).toBe(mafia.roleOf?.(setup, seat.id));
    }

    const mafiaViews = projectSeatViews(mafia, bundle, (mafiaSeat as Seat).id);
    const villagerViews = projectSeatViews(mafia, bundle, (villager as Seat).id);
    const lastMafia = mafiaViews[mafiaViews.length - 1];
    const lastVillager = villagerViews[villagerViews.length - 1];

    const mafiaData = lastMafia?.data as { yourRole?: string };
    const villagerData = lastVillager?.data as { yourRole?: string };
    expect(mafiaData.yourRole).toBe('mafia');
    expect(villagerData.yourRole).not.toBe('mafia');
    // At the opening, the mafia sees a partner and the villager sees nobody.
    const mafiaStart = mafiaViews[0]?.data as { teammates?: string[] };
    const villagerStart = villagerViews[0]?.data as { teammates?: string[] };
    expect(mafiaStart.teammates?.length).toBe(1);
    expect(villagerStart.teammates?.length).toBe(0);
    // The projections are genuinely different perspectives on the same match.
    expect(JSON.stringify(lastMafia)).not.toBe(JSON.stringify(lastVillager));
  });
});

describe('replay compatibility', () => {
  async function played(options: Record<string, unknown>) {
    const seats: Seat[] = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index + 1}`,
      name: `Seat ${index + 1}`,
      kind: 'bot',
    }));
    const bots = new Map(seats.map((seat, index) => [seat.id, new RandomBot(index + 11)]));
    const result = await runMatch(mafia, seats, bots, {
      seed: 9,
      maxActions: 400,
      options,
    });
    let state = mafia.setup({ seed: result.seed, seats, options });
    const godViews = [mafia.godView?.(state) ?? mafia.view(state, 's1')];
    for (const event of result.events) {
      state = mafia.apply(state, event.seatId, event.action);
      godViews.push(mafia.godView?.(state) ?? mafia.view(state, 's1'));
    }
    return { seats, result, godViews };
  }

  it('still rebuilds a legacy bundle whose defaults match the record', async () => {
    const { seats, result, godViews } = await played({});
    const legacy = {
      seed: result.seed,
      seats,
      events: result.events,
      godViews,
    } as unknown as ReplayBundle;
    const views = projectSeatViews(mafia, legacy, 's1');
    expect(views).toHaveLength(result.events.length + 1);
  });

  it('refuses to fake seat views when the stored options are wrong', async () => {
    // Played without a discussion phase, but stored as if it had one.
    const { seats, result, godViews } = await played({ discussionRounds: 0 });
    const mislabelled = {
      seed: result.seed,
      seats,
      options: {},
      events: result.events,
      godViews,
    } as unknown as ReplayBundle;
    expect(() => projectSeatViews(mafia, mislabelled, 's1')).toThrow(ReplayIncompatibleError);
  });
});
