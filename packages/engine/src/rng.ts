/**
 * Deterministic PRNG (mulberry32). Games keep the generator's state inside
 * their own serializable state so that save/resume and replay are exact.
 */
export class Rng {
  private constructor(private s: number) {}

  static fromSeed(seed: number): Rng {
    return new Rng((seed >>> 0) || 0x9e3779b9);
  }

  static restore(snapshot: number): Rng {
    return new Rng(snapshot >>> 0);
  }

  /** Serializable state. Store this in game state. */
  snapshot(): number {
    return this.s;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    return items[this.int(items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }
}
