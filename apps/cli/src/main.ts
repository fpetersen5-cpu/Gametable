/**
 * Headless runner: the same referee the desktop app uses, without a window.
 *
 *   gametable run --game toy.mines --seats 5 --seed 42
 *   gametable run --game toy.mines --seats 4 --llm --model openai/gpt-4o-mini
 *   gametable leaderboard --file ./results.jsonl
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { RandomBot, runMatch, type Controller, type GameDef, type Seat } from '@gametable/engine';
import { mines } from '@gametable/sdk-conformance';
import { OpenRouterClient, createLlmControllers, type LlmSeatConfig } from '@gametable/agent';
import { ResultsStore, bradleyTerry, toRecord } from '@gametable/stats';

const games = new Map<string, GameDef<any>>([[mines.id, mines]]);

function usage(): void {
  console.log(`GameTable

  run          play a match headlessly
                 --game <id> --seats <n> [--seed <n>] [--llm --model <id>]
  models       list models available to your OpenRouter key
  leaderboard  Bradley–Terry ratings from a results file
  games        list installed rule sets

Environment:
  OPENROUTER_API_KEY   required for --llm and models
`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      game: { type: 'string', default: 'toy.mines' },
      seats: { type: 'string', default: '4' },
      seed: { type: 'string' },
      llm: { type: 'boolean', default: false },
      model: { type: 'string' },
      file: { type: 'string', default: './results.jsonl' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') return usage();

  if (command === 'games') {
    for (const game of games.values()) {
      console.log(`${game.id}  ${game.name}  ${game.minSeats}-${game.maxSeats} seats`);
    }
    return;
  }

  if (command === 'models') {
    const key = requireKey();
    const models = await new OpenRouterClient({ apiKey: key }).listModels();
    const free = models.filter((m) => m.free).length;
    console.log(`${models.length} models (${free} free)`);
    for (const model of models.slice(0, 40)) {
      console.log(`  ${model.id.padEnd(48)} ${model.free ? 'free' : ''}`);
    }
    return;
  }

  if (command === 'leaderboard') {
    const store = new ResultsStore(resolve(values.file));
    const records = await store.all();
    if (records.length === 0) {
      console.log(`No results in ${values.file}`);
      return;
    }
    for (const rating of bradleyTerry(records)) {
      console.log(
        `${rating.rating.toFixed(0).padStart(5)}  ${rating.modelId.padEnd(40)} ` +
          `${rating.wins}W/${rating.losses}L  $${rating.avgCostUsd.toFixed(4)}/match`,
      );
    }
    return;
  }

  if (command !== 'run') {
    usage();
    process.exitCode = 1;
    return;
  }

  const def = games.get(values.game);
  if (!def) throw new Error(`unknown game ${values.game}`);
  const count = Number(values.seats);
  if (!Number.isInteger(count) || count < def.minSeats || count > def.maxSeats) {
    throw new Error(`${def.id} needs ${def.minSeats}..${def.maxSeats} seats`);
  }
  if (values.llm && !values.model) throw new Error('--llm needs --model <openrouter-id>');

  const seats: Seat[] = Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    name: `Seat ${i + 1}`,
    kind: values.llm ? 'llm' : 'bot',
    ...(values.llm ? { modelId: values.model as string } : {}),
  }));

  const controllers = new Map<string, Controller>();
  if (values.llm) {
    const client = new OpenRouterClient({
      apiKey: requireKey(),
      appName: 'GameTable',
    });
    const configs = new Map<string, LlmSeatConfig>(
      seats.map((seat) => [seat.id, { model: values.model as string, temperature: 0.8 }]),
    );
    for (const [id, controller] of createLlmControllers(seats, configs, client, def.name)) {
      controllers.set(id, controller);
    }
  } else {
    seats.forEach((seat, i) => controllers.set(seat.id, new RandomBot(i + 1)));
  }

  const seed = values.seed ? Number(values.seed) : Math.floor(Math.random() * 1e9);
  const result = await runMatch(def, seats, controllers, {
    seed,
    actionTimeoutMs: values.llm ? 60_000 : 1_000,
    onEvent: (event) => {
      if (!values.llm) console.log(`  ${event.seatId} → ${JSON.stringify(event.action)}`);
    },
  });

  const names = new Map(result.seats.map((s) => [s.seatId, s.name]));
  console.log('');
  console.log(`match ${result.matchId} (${def.id}) seed ${seed}`);
  console.log(`winner: ${result.winners.map((w) => names.get(w) ?? w).join(', ')}`);
  console.log(`actions: ${result.events.length}  duration: ${result.durationMs}ms`);
  const totalCost = result.seats.reduce((sum, s) => sum + s.usage.costUsd, 0);
  if (totalCost > 0) console.log(`cost: $${totalCost.toFixed(4)}`);

  await new ResultsStore(resolve(values.file)).append(toRecord(result));
}

function requireKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('set OPENROUTER_API_KEY first');
  return key;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
