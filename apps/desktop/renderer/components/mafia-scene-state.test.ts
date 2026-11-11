import { describe, expect, it } from 'vitest';
import { mafia } from '@gametable/games-mafia';
import type { ChatLine, Phase, Seat } from '@gametable/engine';
import { mafiaSceneState, mafiaPhaseIsNight } from './mafia-scene-state';

const seats: Seat[] = Array.from({ length: 7 }, (_, i) => ({ id: `s${i + 1}`, name: `Seat ${i}`, kind: 'bot' }));
const phase: Phase = { id: 'day-talk', label: 'Discussion', kind: 'sequential', actor: 's1', actors: ['s1'], round: 1 };
const line: ChatLine = { id: 'line', seatId: 's1', channel: 'public', text: 'Day speech', phaseId: 'day-talk', round: 1 };

describe('Mafia night presentation', () => {
  it('shows no night actor, spotlight, speech or stale preview to a waiting town seat', () => {
    const state = mafia.setup({ seed: 42, seats, options: {} });
    state.steps = ['night-kill'];
    const town = seats.find((seat) => state.roles[seat.id] === 'villager')!;
    const actor = mafia.phase(state).actors[0]!;
    const view = mafia.view(state, town.id);
    const presentation = mafiaSceneState(view.phase, view.seats, [line], { [actor]: 'A stale preview' });
    expect(presentation).toMatchObject({ night: true, activeIds: [], activeSeatId: null, speakingSeatId: null, dialogue: undefined });
  });

  it('only wakes actors exposed by the current seat projection', () => {
    const state = mafia.setup({ seed: 42, seats, options: {} });
    state.steps = ['night-save'];
    const doctor = seats.find((seat) => state.roles[seat.id] === 'doctor')!;
    const view = mafia.view(state, doctor.id);
    expect(mafiaSceneState(view.phase, view.seats).activeIds).toEqual([doctor.id]);
    const observer = seats.find((seat) => state.roles[seat.id] === 'mafia')!;
    const hidden = mafia.view(state, observer.id);
    expect(mafiaSceneState(hidden.phase, hidden.seats).activeIds).toEqual([]);
  });

  it('drops previous-round chat and day speech when night begins, and private chat at dawn', () => {
    const privateLine = { ...line, channel: 'mafia', text: 'Private speech', phaseId: 'mafia-talk' };
    const night = { ...phase, id: 'mafia-talk' };
    expect(mafiaSceneState(night, seats, [line]).dialogue).toBeUndefined();
    expect(mafiaSceneState(night, seats, [privateLine]).dialogue).toBe('Private speech');
    expect(mafiaSceneState({ ...night, round: 2 }, seats, [privateLine]).dialogue).toBeUndefined();
    expect(mafiaSceneState(phase, seats, [privateLine]).dialogue).toBeUndefined();
    expect(mafiaSceneState(phase, seats, [line]).dialogue).toBe('Day speech');
  });

  it('does not animate eliminated seats or previews from a previous actor', () => {
    const dead = seats.map((seat) => ({ ...seat, alive: seat.id !== 's1' }));
    expect(mafiaSceneState(phase, dead, [], { s1: 'Old', s2: 'Also old' }).activeIds).toEqual([]);
    expect(mafiaSceneState(phase, seats, [], { s2: 'Old' }).speakingSeatId).toBeNull();
    expect(mafiaSceneState(phase, seats, [], { s1: 'Speaking now' }).speakingSeatId).toBe('s1');
    expect(mafiaPhaseIsNight({ ...phase, id: 'dawn' })).toBe(false);
  });
});
