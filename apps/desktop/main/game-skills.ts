/**
 * Per-game "skills" and start prompts for long-term model memory.
 *
 * Each game gets its own skill: a short instruction block that tells the model
 * what to remember and how to write its notes, plus a start prompt used when
 * the model has no memory yet. They are deliberately different per game
 * because what matters in Mafia (roles, lies, votes) is useless in Buckshot
 * (shell probabilities, item value) and in Coup (claims, blocks, coins).
 *
 * Memory is still free text written by the model; these only shape it.
 */

export interface GameSkill {
  /** Stable game id, e.g. "mafia". */
  gameId: string;
  /** Short title shown in Settings and used as the memory section header. */
  title: string;
  /** What the model should keep in its notes while playing this game. */
  skill: string;
  /** Injected when the model has no stored memory for this game yet. */
  startPrompt: string;
}

export const GAME_SKILLS: readonly GameSkill[] = [
  {
    gameId: 'mafia',
    title: 'Mafia / Werewolf',
    skill: [
      'MAFIA MEMORY SKILL',
      '- Remember every claim, accusation and alibi with the seat that made it.',
      '- Track who you suspect and why; update after every vote and every death.',
      '- Note who voted for whom, and whether a vote contradicted a claim.',
      '- Record your own role duties: mafia partners, doctor saves, detective results, lover.',
      '- Keep it to the facts that change your next decision; drop small talk.',
    ].join('\n'),
    startPrompt: [
      'You have no notes from previous games yet.',
      'Start a memory habit now: after each of your turns, write one or two lines',
      'naming the seat, the claim or vote, and why it matters. You will see these',
      'notes again in your next Mafia game.',
    ].join('\n'),
  },
  {
    gameId: 'buckshot',
    title: 'Buckshot Roulette',
    skill: [
      'BUCKSHOT MEMORY SKILL',
      '- Remember the shell history: every shell fired, live or blank, and who fired it.',
      '- Track items you and the opponent have used and what remains.',
      '- Note health swings, sawed-off shots and handcuff skips per round.',
      '- Keep the running live/blank estimate and your best guess of the chamber.',
      '- Write down which lines paid off (peeks, inverter, beer) and which did not.',
    ].join('\n'),
    startPrompt: [
      'You have no notes from previous duels yet.',
      'Start a memory habit now: after each shot, note the shell, the damage and',
      'the items spent. These notes return in your next Buckshot game.',
    ].join('\n'),
  },
  {
    gameId: 'coup',
    title: 'Coup',
    skill: [
      'COUP MEMORY SKILL',
      '- Remember every claimed role, challenge and block, with the seat that made it.',
      '- Track who lost which influence and what is in the discard pile.',
      '- Note coin counts you can infer from actions (coup = 7, assassinate = 3).',
      '- Record who has been challenged successfully or caught lying.',
      '- Keep your own hidden cards and the deck count in mind; never write others’ cards.',
    ].join('\n'),
    startPrompt: [
      'You have no notes from previous Coup games yet.',
      'Start a memory habit now: after each challenge or block, write who claimed',
      'what and what happened. These notes return in your next Coup game.',
    ].join('\n'),
  },
];

const BY_GAME = new Map(GAME_SKILLS.map((skill) => [skill.gameId, skill]));

/** Skill for a game, or a neutral default for games without a dedicated skill. */
export function skillForGame(gameId: string): GameSkill {
  return (
    BY_GAME.get(gameId) ?? {
      gameId,
      title: gameId,
      skill: [
        'MEMORY SKILL',
        '- Remember the facts that change your next decision: claims, votes,',
        'resources and outcomes, each tied to the seat that produced them.',
        '- Update suspicions after every action; drop what no longer matters.',
      ].join('\n'),
      startPrompt: 'You have no notes from previous games yet. Start keeping brief notes now; they return in your next game.',
    }
  );
}

/**
 * Memory shown to the model: the game skill header, a start prompt when the
 * model has no stored notes yet, then the stored notes. The skill block is
 * delimited so it can be stripped again before saving.
 */
export function composeMemory(skill: GameSkill, stored: string): string {
  const trimmed = stored.trim();
  const header = `[skill: ${skill.title}]\n${skill.skill}`;
  const start = trimmed ? '' : `\n\n${skill.startPrompt}`;
  const notes = trimmed ? `\n\n[notes]\n${trimmed}` : '';
  return `${header}${start}${notes}`.slice(-MODEL_MEMORY_LIMIT);
}

/** Remove the skill header (and any start prompt) before persisting notes. */
export function stripSkillBlock(notes: string): string {
  return notes
    .replace(/^\[skill: [^\]]*\]\n[\s\S]*?(?=\n\n)/m, '')
    .replace(/\n\nYou have no notes[\s\S]*(?=\n\n\[notes\]|$)/m, '')
    .replace(/\n\n\[notes\]\n?/m, '\n\n')
    .trim();
}

/** Memory limit shared with the agent layer so prompts stay bounded. */
const MODEL_MEMORY_LIMIT = 4_000;
