import { describe, expect, it } from 'vitest';
import { GAME_SKILLS, composeMemory, skillForGame, stripSkillBlock } from './game-skills.js';

describe('game skills', () => {
  it('has a distinct skill and start prompt for every shipped game', () => {
    expect(GAME_SKILLS.map((skill) => skill.gameId).sort()).toEqual(['buckshot', 'coup', 'mafia']);
    const skills = GAME_SKILLS.map((skill) => skill.skill);
    const starts = GAME_SKILLS.map((skill) => skill.startPrompt);
    expect(new Set(skills).size).toBe(GAME_SKILLS.length);
    expect(new Set(starts).size).toBe(GAME_SKILLS.length);
    for (const skill of GAME_SKILLS) {
      expect(skill.skill.length).toBeGreaterThan(80);
      expect(skill.startPrompt).toMatch(/no notes/i);
    }
  });

  it('falls back to a neutral skill for unknown games', () => {
    const fallback = skillForGame('some.other.game');
    expect(fallback.gameId).toBe('some.other.game');
    expect(fallback.skill).toContain('MEMORY SKILL');
    expect(skillForGame('mafia')).toBe(GAME_SKILLS.find((skill) => skill.gameId === 'mafia'));
  });

  it('composes skill, start prompt and stored notes for a new model', () => {
    const skill = skillForGame('mafia');
    const memory = composeMemory(skill, '');
    expect(memory).toContain('[skill: Mafia / Werewolf]');
    expect(memory).toContain('MAFIA MEMORY SKILL');
    expect(memory).toContain(skill.startPrompt);
    expect(memory).not.toContain('[notes]');
  });

  it('composes skill and notes without a start prompt once notes exist', () => {
    const skill = skillForGame('coup');
    const memory = composeMemory(skill, 's2 claimed Duke twice and was believed.');
    expect(memory).toContain('COUP MEMORY SKILL');
    expect(memory).toContain('[notes]');
    expect(memory).toContain('s2 claimed Duke twice');
    expect(memory).not.toContain(skill.startPrompt);
  });

  it('strips the skill block and start prompt so only real notes persist', () => {
    const skill = skillForGame('buckshot');
    const fresh = composeMemory(skill, '');
    expect(stripSkillBlock(fresh)).toBe('');

    const withNotes = composeMemory(skill, 'last chamber: 3 live 2 blank');
    const roundTrip = stripSkillBlock(withNotes);
    expect(roundTrip).toBe('last chamber: 3 live 2 blank');
    expect(roundTrip).not.toContain('BUCKSHOT MEMORY SKILL');
    expect(roundTrip).not.toContain('[skill:');
  });
});
