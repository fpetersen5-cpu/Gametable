/**
 * Mafia / Werewolf — 5 to 11 seats, one human plus up to ten models.
 *
 * Night: the mafia talk privately and vote on a kill, the doctor may save one
 * seat, the detective learns one alignment. Day: everyone speaks in turn, then
 * votes; a tie goes to a runoff; a second tie kills nobody.
 *
 * The engine owns all hidden state. A seat's view contains its own role, the
 * public record, and only the private channels it is entitled to.
 */
import {
  IllegalAction,
  Rng,
  type ChatLine,
  type GameAction,
  type GameDef,
  type GameView,
  type Phase,
  type SeatId,
  type SeatInfo,
  type SetupContext,
} from '@gametable/engine';

export type Role = 'villager' | 'mafia' | 'doctor' | 'detective' | 'jester';

export type StepId =
  | 'mafia-talk'
  | 'night-kill'
  | 'night-save'
  | 'night-check'
  | 'dawn'
  | 'day-talk'
  | 'day-vote'
  | 'runoff';

const ROLE_TEXT: Record<Role, string> = {
  villager: 'Villager — find the mafia and vote them out.',
  mafia: 'Mafia — each night you and your partners kill one townsperson.',
  doctor: 'Doctor — each night you may protect one person from the kill.',
  detective: 'Detective — each night you learn whether one person is mafia.',
  jester: 'Jester — you win the moment the town votes you out.',
};

export interface MafiaState {
  seats: { id: SeatId; name: string; kind: 'human' | 'llm' | 'bot'; modelId?: string }[];
  roles: Record<SeatId, Role>;
  alive: SeatId[];
  day: number;
  steps: StepId[];
  votes: Record<SeatId, SeatId>;
  talkIndex: number;
  talkRound: number;
  discussionRounds: number;
  runoff: SeatId[];
  pendingKill: SeatId | null;
  savedTonight: SeatId | null;
  chat: ChatLine[];
  log: string[];
  checks: Record<SeatId, Record<SeatId, 'mafia' | 'town'>>;
  over: 'town' | 'mafia' | 'jester' | null;
  rngState: number;
  stats: { speeches: number; votes: number; lynched: number };
}

const STEP_LABEL: Record<StepId, string> = {
  'mafia-talk': 'Night — the mafia confer',
  'night-kill': 'Night — the mafia choose a victim',
  'night-save': 'Night — the doctor may protect someone',
  'night-check': 'Night — the detective investigates',
  dawn: 'Dawn',
  'day-talk': 'Day — discussion',
  'day-vote': 'Day — vote to eliminate',
  runoff: 'Day — runoff vote',
};

function roleOf(state: MafiaState, seatId: SeatId): Role {
  const role = state.roles[seatId];
  if (!role) throw new Error(`unknown seat: ${seatId}`);
  return role;
}

function aliveWithRole(state: MafiaState, role: Role): SeatId[] {
  return state.alive.filter((id) => state.roles[id] === role);
}

function nameOf(state: MafiaState, seatId: SeatId): string {
  return state.seats.find((seat) => seat.id === seatId)?.name ?? seatId;
}

function pushLog(state: MafiaState, text: string): void {
  state.log.push(text);
}

/** Who may act in the current step. Empty means the step is automatic. */
function actorsFor(state: MafiaState): SeatId[] {
  const step = state.steps[0];
  if (!step || state.over) return [];
  switch (step) {
    case 'mafia-talk': {
      const mafia = aliveWithRole(state, 'mafia');
      const talker = mafia[state.talkIndex % Math.max(mafia.length, 1)];
      return talker ? [talker] : [];
    }
    case 'night-kill':
      return aliveWithRole(state, 'mafia');
    case 'night-save': {
      const doctor = aliveWithRole(state, 'doctor')[0];
      return doctor ? [doctor] : [];
    }
    case 'night-check': {
      const detective = aliveWithRole(state, 'detective')[0];
      return detective ? [detective] : [];
    }
    case 'dawn':
      return [];
    case 'day-talk': {
      const speaker = state.alive[state.talkIndex % Math.max(state.alive.length, 1)];
      return speaker ? [speaker] : [];
    }
    case 'day-vote':
    case 'runoff':
      return [...state.alive];
    default:
      return [];
  }
}

export function legalActionsFor(state: MafiaState, seatId: SeatId): GameAction[] {
  if (state.over) return [];
  if (!actorsFor(state).includes(seatId)) return [];
  const step = state.steps[0];

  switch (step) {
    case 'mafia-talk':
    case 'day-talk':
      return [{ type: 'say', text: '' }];
    case 'night-kill': {
      const mafia = new Set(aliveWithRole(state, 'mafia'));
      return state.alive
        .filter((id) => !mafia.has(id))
        .map((id) => ({ type: 'kill', target: id }));
    }
    case 'night-save':
      return [{ type: 'skip' }, ...state.alive.map((id) => ({ type: 'save', target: id }))];
    case 'night-check':
      return state.alive
        .filter((id) => id !== seatId)
        .map((id) => ({ type: 'investigate', target: id }));
    case 'day-vote':
      return state.alive.filter((id) => id !== seatId).map((id) => ({ type: 'vote', target: id }));
    case 'runoff':
      return state.runoff
        .filter((id) => id !== seatId)
        .map((id) => ({ type: 'vote', target: id }));
    default:
      return [];
  }
}

function tally(votes: Record<SeatId, SeatId>): { top: SeatId[]; counts: Record<SeatId, number> } {
  const counts: Record<SeatId, number> = {};
  for (const target of Object.values(votes)) counts[target] = (counts[target] ?? 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.entries(counts)
    .filter(([, n]) => n === max && max > 0)
    .map(([id]) => id);
  return { top, counts };
}

function checkWin(state: MafiaState): void {
  if (state.over) return;
  const mafia = aliveWithRole(state, 'mafia').length;
  const town = state.alive.length - mafia;
  if (mafia === 0) state.over = 'town';
  else if (mafia >= town) state.over = 'mafia';
}

function eliminate(state: MafiaState, seatId: SeatId, cause: 'night' | 'vote'): void {
  state.alive = state.alive.filter((id) => id !== seatId);
  const role = state.roles[seatId] as Role;
  pushLog(
    state,
    `${nameOf(state, seatId)} was ${cause === 'night' ? 'killed in the night' : 'voted out'}. ` +
      `They were the ${role}.`,
  );
  if (cause === 'vote') state.stats.lynched += 1;
  if (cause === 'vote' && role === 'jester') {
    state.over = 'jester';
    return;
  }
  checkWin(state);
}

function processDawn(state: MafiaState): void {
  state.day += 1;
  pushLog(state, `Day ${state.day} breaks.`);
  if (state.pendingKill && state.pendingKill !== state.savedTonight) {
    eliminate(state, state.pendingKill, 'night');
  } else if (state.pendingKill) {
    pushLog(state, `${nameOf(state, state.pendingKill)} was attacked but survived.`);
  } else {
    pushLog(state, 'Nobody died in the night.');
  }
  state.pendingKill = null;
  state.savedTonight = null;
}

function buildCycleSteps(state: MafiaState): StepId[] {
  const steps: StepId[] = [];
  const mafia = aliveWithRole(state, 'mafia');
  if (mafia.length > 1) steps.push('mafia-talk');
  if (mafia.length > 0) steps.push('night-kill');
  if (aliveWithRole(state, 'doctor').length > 0) steps.push('night-save');
  if (aliveWithRole(state, 'detective').length > 0) steps.push('night-check');
  steps.push('dawn');
  // A silent day (discussionRounds: 0) skips straight to the vote. This is the
  // null-capability path the M2c gate runs for chat-free play.
  if (state.discussionRounds > 0) steps.push('day-talk');
  steps.push('day-vote');
  return steps;
}

function shiftStep(state: MafiaState): void {
  state.steps.shift();
  state.votes = {};
  state.talkIndex = 0;
  state.talkRound = 0;
}

/** Advance through automatic steps (dawn, empty roles) until someone must act. */
function settle(state: MafiaState): void {
  let guard = 0;
  while (!state.over && guard++ < 50) {
    if (state.steps.length === 0) state.steps = buildCycleSteps(state);
    const step = state.steps[0];
    if (!step) break;
    if (actorsFor(state).length > 0) return;
    if (step === 'dawn') processDawn(state);
    shiftStep(state);
  }
}

function finishStep(state: MafiaState): void {
  shiftStep(state);
  settle(state);
}

function resolveVotes(state: MafiaState): void {
  const step = state.steps[0];
  const { top } = tally(state.votes);

  if (step === 'night-kill') {
    state.pendingKill = top.length === 1 ? (top[0] as SeatId) : null;
    pushLog(
      state,
      state.pendingKill
        ? 'The mafia have chosen their victim.'
        : 'The mafia could not agree; nobody is attacked.',
    );
    finishStep(state);
    return;
  }

  if (step === 'night-save') {
    pushLog(state, 'The doctor has made their choice.');
    finishStep(state);
    return;
  }

  if (step === 'day-vote') {
    if (top.length === 1) {
      const target = top[0] as SeatId;
      shiftStep(state);
      eliminate(state, target, 'vote');
      settle(state);
      return;
    }
    state.runoff = top;
    state.votes = {};
    pushLog(
      state,
      `The vote is tied between ${top.map((id) => nameOf(state, id)).join(' and ')}. Runoff.`,
    );
    state.steps.shift();
    state.steps.unshift('runoff');
    return;
  }

  if (step === 'runoff') {
    const target = top.length === 1 ? (top[0] as SeatId) : null;
    pushLog(
      state,
      target
        ? `${nameOf(state, target)} is eliminated in the runoff.`
        : 'The runoff is tied. Nobody is eliminated.',
    );
    shiftStep(state);
    if (target) eliminate(state, target, 'vote');
    settle(state);
  }
}

function dealRoles(state: MafiaState, rng: Rng): void {
  const count = state.seats.length;
  const mafiaCount = count <= 6 ? 1 : count <= 9 ? 2 : 3;
  const order = rng.shuffle(state.seats.map((seat) => seat.id));
  const roles: Record<SeatId, Role> = {};
  for (const id of state.seats.map((seat) => seat.id)) roles[id] = 'villager';
  order.slice(0, mafiaCount).forEach((id) => {
    roles[id] = 'mafia';
  });
  let cursor = mafiaCount;
  const grant = (role: Role) => {
    const id = order[cursor++];
    if (id) roles[id] = role;
  };
  grant('doctor');
  if (count >= 6) grant('detective');
  if (count >= 8) grant('jester');
  state.roles = roles;
}

export const mafia: GameDef<MafiaState> = {
  id: 'mafia',
  name: 'Mafia / Werewolf',
  version: '1.0.0',
  minSeats: 5,
  maxSeats: 11,
  capabilities: {
    chat: true,
    simultaneousPhases: true,
    items: false,
    health: false,
    solver: false,
    uiPanels: ['seat-ring', 'phase-banner', 'action-panel', 'chat', 'vote-tally', 'role-card'],
  },

  setup(ctx: SetupContext): MafiaState {
    if (ctx.seats.length < 5 || ctx.seats.length > 11) {
      throw new Error('Mafia needs 5 to 11 seats');
    }
    const rng = Rng.fromSeed(ctx.seed);
    const state: MafiaState = {
      seats: ctx.seats.map((seat) => ({
        id: seat.id,
        name: seat.name,
        kind: seat.kind,
        ...(seat.modelId ? { modelId: seat.modelId } : {}),
      })),
      roles: {},
      alive: ctx.seats.map((seat) => seat.id),
      day: 0,
      steps: [],
      votes: {},
      talkIndex: 0,
      talkRound: 0,
      discussionRounds:
        typeof ctx.options.discussionRounds === 'number'
          ? Math.max(0, Math.min(3, ctx.options.discussionRounds))
          : 1,
      runoff: [],
      pendingKill: null,
      savedTonight: null,
      chat: [],
      log: [],
      checks: Object.fromEntries(ctx.seats.map((seat) => [seat.id, {}])),
      over: null,
      rngState: rng.snapshot(),
      stats: { speeches: 0, votes: 0, lynched: 0 },
    };
    dealRoles(state, rng);
    state.rngState = rng.snapshot();
    pushLog(state, `A game of Mafia with ${ctx.seats.length} seats begins.`);
    settle(state);
    return state;
  },

  phase(state): Phase {
    const step = state.steps[0] ?? 'dawn';
    const actors = actorsFor(state);
    return {
      id: step,
      label: STEP_LABEL[step] ?? step,
      kind:
        step === 'night-kill' || step === 'day-vote' || step === 'runoff'
          ? 'simultaneous'
          : 'sequential',
      actor: actors[0] ?? null,
      actors,
      round: state.day,
    };
  },

  view(state, seatId): GameView {
    const role = roleOf(state, seatId);
    const step = state.steps[0] ?? 'dawn';
    const mafiaSeats = aliveWithRole(state, 'mafia');
    const teammates = role === 'mafia' ? mafiaSeats.filter((id) => id !== seatId) : [];
    const seatNames = new Map(state.seats.map((seat) => [seat.id, seat.name]));

    const visibleChat = state.chat.filter(
      (line) => line.channel === 'public' || (line.channel === 'mafia' && role === 'mafia'),
    );
    const votes = Object.entries(state.votes).map(([voter, target]) => ({
      voter,
      voterName: seatNames.get(voter) ?? voter,
      target,
      targetName: seatNames.get(target) ?? target,
    }));

    const seats: SeatInfo[] = state.seats.map((seat) => ({
      id: seat.id,
      name: seat.name,
      kind: seat.kind,
      modelId: seat.modelId,
      alive: state.alive.includes(seat.id),
    }));

    const canAct = !state.over && actorsFor(state).includes(seatId);

    return {
      gameId: mafia.id,
      seatId,
      phase: mafia.phase(state),
      seats,
      data: {
        day: state.day,
        step,
        yourRole: role,
        yourRoleText: ROLE_TEXT[role],
        teammates,
        alive: [...state.alive],
        votes,
        runoff: [...state.runoff],
        log: state.log.slice(-24),
        checks:
          role === 'detective'
            ? Object.entries(state.checks[seatId] ?? {}).map(([target, result]) => ({
                target,
                targetName: seatNames.get(target) ?? target,
                result,
              }))
            : [],
        canAct,
        over: state.over,
      },
      briefing: mafia.briefing(state, seatId),
      chat: visibleChat,
      legalActions: canAct ? legalActionsFor(state, seatId) : [],
      terminal: state.over !== null,
      winners: mafia.scoring(state).winners,
    };
  },

  apply(state, seatId, action) {
    if (state.over) throw new IllegalAction(seatId, action, 'the match is over');
    roleOf(state, seatId);
    if (!actorsFor(state).includes(seatId)) {
      throw new IllegalAction(seatId, action, 'not your turn');
    }
    const step = state.steps[0];
    const next = structuredClone(state) as MafiaState;

    if (step === 'mafia-talk' || step === 'day-talk') {
      if (action.type !== 'say') throw new IllegalAction(seatId, action, 'only speech is allowed');
      const spoken = String(action.text ?? '').trim().slice(0, 600);
      const text = spoken || '…'; // silence is a legal, if unhelpful, turn
      next.chat.push({
        id: `c${next.chat.length + 1}`,
        seatId,
        channel: step === 'mafia-talk' ? 'mafia' : 'public',
        text,
        phaseId: step,
        round: next.day,
      });
      next.stats.speeches += 1;

      const roster = step === 'mafia-talk' ? aliveWithRole(next, 'mafia') : next.alive;
      next.talkIndex += 1;
      if (next.talkIndex >= roster.length) {
        next.talkIndex = 0;
        next.talkRound += 1;
        if (step === 'mafia-talk' || next.talkRound >= next.discussionRounds) {
          finishStep(next);
        }
      }
      return next;
    }

    const legal = legalActionsFor(state, seatId);
    const chosen = legal.find(
      (option) => option.type === action.type && option.target === action.target,
    );
    if (!chosen) throw new IllegalAction(seatId, action, 'illegal action');

    if (step === 'night-save') {
      next.savedTonight = chosen.type === 'save' ? String(chosen.target) : null;
      pushLog(next, 'The doctor has made their choice.');
      finishStep(next);
      return next;
    }

    if (step === 'night-check') {
      const target = String(chosen.target);
      const result = next.roles[target] === 'mafia' ? 'mafia' : 'town';
      next.checks[seatId] = { ...next.checks[seatId], [target]: result };
      pushLog(next, `The detective has investigated ${nameOf(next, target)}.`);
      finishStep(next);
      return next;
    }

    if (step === 'night-kill' || step === 'day-vote' || step === 'runoff') {
      next.votes[seatId] = String(chosen.target);
      next.stats.votes += 1;
      const expected = actorsFor(state);
      if (Object.keys(next.votes).length >= expected.length) resolveVotes(next);
      return next;
    }

    throw new IllegalAction(seatId, action, 'no action here');
  },

  terminal(state) {
    return state.over !== null;
  },

  scoring(state) {
    const scores: Record<SeatId, number> = {};
    for (const seat of state.seats) {
      const role = state.roles[seat.id];
      if (!role) {
        scores[seat.id] = 0; // a seat with no role is a spectator, never a winner
        continue;
      }
      const winner =
        state.over === 'jester'
          ? role === 'jester'
          : state.over === 'mafia'
            ? role === 'mafia'
            : state.over === 'town'
              ? role !== 'mafia'
              : false;
      scores[seat.id] = winner ? 1 : 0;
    }
    const winners = state.seats.filter((seat) => scores[seat.id] === 1).map((seat) => seat.id);
    return { winners, scores };
  },

  metrics(state) {
    return {
      days: state.day,
      speeches: state.stats.speeches,
      votes: state.stats.votes,
      lynched: state.stats.lynched,
    };
  },

  metricsFor(state, seatId) {
    const role = roleOf(state, seatId);
    return {
      survived: state.alive.includes(seatId) ? 1 : 0,
      roleMafia: role === 'mafia' ? 1 : 0,
    };
  },

  briefing(state, seatId) {
    const role = roleOf(state, seatId);
    const mafiaSeats = aliveWithRole(state, 'mafia');
    const teammates =
      role === 'mafia' ? mafiaSeats.filter((id) => id !== seatId).map((id) => nameOf(state, id)) : [];
    const lines = [
      `You are ${nameOf(state, seatId)}, the ${role.toUpperCase()} in a game of Mafia.`,
      ROLE_TEXT[role],
      role === 'mafia'
        ? `Your partners: ${teammates.length ? teammates.join(', ') : '(none left)'}.`
        : 'You do not know who the mafia are.',
      '',
      'RULES',
      '- Night: the mafia kill one townsperson; the doctor may save one; the detective checks one alignment.',
      '- Day: everyone speaks once in seat order, then everyone votes.',
      '- A tied vote goes to a runoff between the tied seats; a tied runoff kills nobody.',
      '- The town wins when every mafia is gone. The mafia win when they equal or outnumber the town.',
      '- Roles are revealed when a seat dies. Seats may lie about anything they say.',
    ];
    if (role === 'detective') {
      const checks = Object.entries(state.checks[seatId] ?? {});
      lines.push(
        '',
        checks.length
          ? `Your investigations: ${checks
              .map(([target, result]) => `${nameOf(state, target)} is ${result}`)
              .join('; ')}`
          : 'You have not investigated anyone yet.',
      );
    }
    return lines.join('\n');
  },

  godView(state): GameView {
    const first = state.seats[0]?.id;
    const base = mafia.view(state, first as SeatId);
    return {
      ...base,
      seatId: '__all__',
      data: {
        ...(base.data as Record<string, unknown>),
        yourRole: null,
        yourRoleText: '',
        teammates: [],
        checks: [],
        god: {
          roles: state.roles,
          mafia: aliveWithRole(state, 'mafia'),
          checks: Object.entries(state.checks).flatMap(([owner, results]) =>
            Object.entries(results).map(([target, result]) => ({ owner, target, result })),
          ),
        },
      },
      chat: [...state.chat],
      legalActions: [],
    };
  },

  secrets(state, seatId) {
    const role = roleOf(state, seatId);
    const secrets: string[] = [];
    for (const seat of state.seats) {
      if (seat.id === seatId) continue;
      secrets.push(`#role#${seat.id}#${state.roles[seat.id]}#`);
    }    if (role !== 'mafia') {
      for (const mafioso of aliveWithRole(state, 'mafia')) {
        secrets.push(`#mafia#${mafioso}#`);
      }
      for (const line of state.chat.filter((entry) => entry.channel === 'mafia')) {
        secrets.push(`#mafia-chat#${line.id}#`);
      }
    }
    for (const [owner, results] of Object.entries(state.checks)) {
      if (owner === seatId) continue;
      for (const [target, result] of Object.entries(results)) {
        secrets.push(`#check#${owner}#${target}#${result}#`);
      }
    }
    return secrets;
  },

  roleOf(state, seatId) {
    return state.roles[seatId];
  },
};
