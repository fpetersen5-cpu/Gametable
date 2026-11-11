import { Semaphore, type CompletionClient, type CompletionRequest, type SharedBudget } from '@gametable/agent';

export class BudgetExceeded extends Error {
  constructor() { super('Match budget reached.'); }
}

/**
 * Provider costs arrive with the response. Serialize calls so an outstanding
 * charge is settled before another seat or repair can use the remaining budget.
 * A single admitted call may still cost more than the remaining amount.
 */
export class Budget implements SharedBudget {
  private spent = 0;
  private hit = false;
  private readonly calls = new Semaphore(1);

  constructor(
    readonly capUsd: number,
    private readonly onExhausted: () => void = () => undefined,
  ) {}

  remaining(): number {
    return Math.max(0, this.capUsd - this.spent);
  }

  spend(costUsd: number): void {
    if (Number.isFinite(costUsd) && costUsd > 0) this.spent += costUsd;
  }

  exhausted(): void {
    if (this.hit) return;
    this.hit = true;
    this.onExhausted();
  }

  client(inner: CompletionClient): CompletionClient {
    return { complete: (request: CompletionRequest) => this.calls.run(async () => {
      if (this.remaining() <= 0) {
        this.exhausted();
        throw new BudgetExceeded();
      }
      const result = await inner.complete(request);
      this.spend(result.usage.costUsd);
      return result;
    }, request.signal) };
  }

  get spentUsd(): number { return this.spent; }
  get hitCap(): boolean { return this.hit; }
}
