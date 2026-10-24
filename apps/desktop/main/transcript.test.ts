import { describe, expect, it } from 'vitest';
import { mafia } from '@gametable/games-mafia';
import { coup } from '@gametable/games-coup';
import { buckshot } from '@gametable/games-buckshot';
import { buildTranscript } from './transcript.js';
import { ReplayIncompatibleError } from './replay.js';
import { replayFixture } from './test-fixtures/replay.js';
import { validateTranscriptPerspective } from './validation.js';

function mafiaRecord() {
  const fixture = replayFixture(mafia, 8);
  const mob = fixture.seats.filter((seat) => fixture.state.roles[seat.id] === 'mafia');
  const town = fixture.seats.find((seat) => fixture.state.roles[seat.id] === 'villager')!;
  for (const seat of mob) fixture.apply(seat.id, { type: 'raise' });
  fixture.apply(mafia.phase(fixture.state).actor!, { type: 'say', text: 'PRIVATE-MAFIA-CANARY-9153' });
  fixture.apply(mafia.phase(fixture.state).actor!, { type: 'close-night-talk' });
  while (mafia.phase(fixture.state).id !== 'day-talk') {
    const phase = mafia.phase(fixture.state);
    const actor = phase.kind === 'simultaneous'
      ? phase.actors.find((id) => !(id in fixture.state.votes))!
      : phase.actor!;
    if (!actor) throw new Error('unexpected automatic phase');
    const actions = mafia.view(fixture.state, actor).legalActions;
    fixture.apply(actor, actions.find((action) => action.type === 'skip') ?? actions[0]!);
  }
  fixture.apply(mafia.phase(fixture.state).actor!, { type: 'say', text: 'PUBLIC-SPEECH-CANARY-4822' });
  return { bundle: fixture.bundle(), mob: mob[0]!.id, town: town.id };
}

function coupExchange(choice = 0) {
  const fixture = replayFixture(coup, 3);
  fixture.apply('s1', { type: 'exchange' });
  fixture.apply('s2', { type: 'pass' });
  fixture.apply('s3', { type: 'pass' });
  const choices = coup.view(fixture.state, 's1').legalActions;
  fixture.apply('s1', choices[choice]!);
  return fixture.bundle();
}

describe('transcript privacy', () => {
  it('defaults to public-only, not the stored human or god perspective', () => {
    const { bundle } = mafiaRecord();
    bundle.summary.seats.forEach((seat) => { seat.role = 'SUMMARY-ROLE-CANARY-9911'; });
    bundle.summary.metrics.privateValue = 736251;
    bundle.debrief = { text: 'DEBRIEF-PRIVATE-CANARY-4421', model: 'test', costUsd: 0 };
    bundle.views.forEach((view) => { view.briefing = 'STORED-VIEW-CANARY-8743'; });
    const markdown = buildTranscript(mafia, bundle);
    expect(markdown).toContain('Perspective: Public only');
    expect(markdown).toContain('PUBLIC-SPEECH-CANARY-4822');
    expect(markdown).toContain('Total cost $0.0042');
    for (const secret of ['PRIVATE-MAFIA-CANARY-9153', 'SUMMARY-ROLE-CANARY-9911',
      'DEBRIEF-PRIVATE-CANARY-4421', 'STORED-VIEW-CANARY-8743', '736251']) {
      expect(markdown).not.toContain(secret);
    }
    expect(markdown).not.toContain('## Actions');
    expect(markdown).not.toContain('target=');
    expect(markdown).not.toContain('| Role |');
  });

  it('includes private chat only for an authorized seat, with a sharing warning', () => {
    const { bundle, mob, town } = mafiaRecord();
    const townText = buildTranscript(mafia, bundle, { mode: 'seat', seatId: town });
    const mobText = buildTranscript(mafia, bundle, { mode: 'seat', seatId: mob });
    expect(townText).not.toContain('PRIVATE-MAFIA-CANARY-9153');
    expect(mobText).toContain('PRIVATE-MAFIA-CANARY-9153');
    expect(mobText).toContain('PRIVATE SEAT TRANSCRIPT');
    expect(townText).toContain('PUBLIC-SPEECH-CANARY-4822');
    expect(townText).not.toContain('"god"');
  });

  it('omits raw exchange choices and is unchanged by different private card selections', () => {
    const a = coupExchange(0);
    const b = coupExchange(1);
    expect(a.events.at(-1)!.action).not.toEqual(b.events.at(-1)!.action);
    expect(buildTranscript(coup, a)).toBe(buildTranscript(coup, b));
    expect(buildTranscript(coup, a, { mode: 'seat', seatId: 's2' }))
      .toBe(buildTranscript(coup, b, { mode: 'seat', seatId: 's2' }));
    expect(buildTranscript(coup, a, { mode: 'seat', seatId: 's1' }))
      .not.toBe(buildTranscript(coup, b, { mode: 'seat', seatId: 's1' }));
    expect(buildTranscript(coup, a)).not.toContain('first=');
    expect(buildTranscript(coup, a)).not.toContain('"hand"');
    expect(buildTranscript(coup, a, { mode: 'seat', seatId: 's2' })).not.toContain('exchangeCards');
  });

  it('filters private Buckshot logs and peeks but retains the public item-use record', () => {
    const fixture = replayFixture(buckshot, 2, { carryItems: [['magnifier'], []] });
    fixture.apply('s1', { type: 'use', item: 'magnifier' });
    const bundle = fixture.bundle();
    const publicText = buildTranscript(buckshot, bundle);
    expect(publicText).toContain('uses a magnifying glass');
    expect(publicText).not.toContain('peers into the chamber');
    expect(buildTranscript(buckshot, bundle, { mode: 'seat', seatId: 's2' })).not.toContain('peers into the chamber');
    expect(buildTranscript(buckshot, bundle, { mode: 'seat', seatId: 's1' })).toContain('peers into the chamber');
  });

  it('requires explicit omniscient mode for the full raw record, clearly labelled', () => {
    const { bundle } = mafiaRecord();
    const markdown = buildTranscript(mafia, bundle, { mode: 'omniscient' });
    expect(markdown).toContain('Perspective: Omniscient');
    expect(markdown).toContain('WARNING: FULL PRIVATE RECORD');
    expect(markdown).toContain('PRIVATE-MAFIA-CANARY-9153');
    expect(markdown).toContain('## Actions');
  });

  it('fails closed on incompatible records instead of falling back to god views', () => {
    const bundle = coupExchange();
    bundle.godViews.at(-1)!.data = { privateCanary: 'DO-NOT-FALL-BACK-9231' };
    expect(() => buildTranscript(coup, bundle)).toThrow(ReplayIncompatibleError);
    expect(() => buildTranscript(coup, bundle, { mode: 'seat', seatId: 's2' })).toThrow(ReplayIncompatibleError);
  });

  it('rejects unknown seats and invalid perspective requests', () => {
    expect(() => buildTranscript(coup, coupExchange(), { mode: 'seat', seatId: 'ghost' })).toThrow();
    for (const invalid of [null, 'god', {}, { mode: 'god' }, { mode: 'seat' }, { mode: 'seat', seatId: '../secrets'.repeat(10) }]) {
      expect(() => validateTranscriptPerspective(invalid)).toThrow();
    }
    expect(validateTranscriptPerspective(undefined)).toEqual({ mode: 'public' });
  });

  it('renders untrusted speech as text instead of active HTML or remote images', () => {
    const fixture = replayFixture(mafia, 5);
    while (mafia.phase(fixture.state).id !== 'day-talk') {
      const actor = mafia.phase(fixture.state).actor!;
      const action = mafia.view(fixture.state, actor).legalActions[0]!;
      fixture.apply(actor, action);
    }
    fixture.apply(mafia.phase(fixture.state).actor!, { type: 'say', text: '<img src="https://evil.invalid"> ![tracker](https://evil.invalid)' });
    const markdown = buildTranscript(mafia, fixture.bundle());
    expect(markdown).not.toContain('<img');
    expect(markdown).not.toContain('![tracker](');
    expect(markdown).toContain('&lt;img');
  });
});
