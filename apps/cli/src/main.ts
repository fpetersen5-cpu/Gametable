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
import { buckshot, runGauntlet } from '@gametable/games-buckshot';
import { coup } from '@gametable/games-coup';
import { mafia } from '@gametable/games-mafia';
import {
  LlmController,
  OpenAICompatibleClient,
  OpenRouterClient,
  createLlmControllers,
  listLocalModels,
  type LlmSeatConfig,
} from '@gametable/agent';
import { ResultsStore, bradleyTerry, toRecord } from '@gametable/stats';

const games = new Map<string, GameDef<any>>([
  [mines.id, mines],
  [buckshot.id, buckshot],
  [mafia.id, mafia],
  [coup.id, coup],
]);

function usage(): void {
  console.log(`GameTable

  run          play a match headlessly
                 --game <id> --seats <n> [--seed <n>] [--llm --model <id> [--base-url <url>]] [--oracle]
  gauntlet     duel a ladder of opponents (Buckshot)
                 [--models a,b,c] [--oracle] [--seed <n>]
  models       list models from OpenRouter, or from --base-url
  leaderboard  Bradley–Terry ratings from a results file
  games        list installed rule sets

Environment:
  OPENROUTER_API_KEY   required for cloud --llm and OpenRouter models
`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      game: { type: 'string', default: 'toy.mines' },
      seats: { type: 'string' },
      seed: { type: 'string' },
      llm: { type: 'boolean', default: false },
      oracle: { type: 'boolean', default: false },
      models: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
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
    const models = values['base-url']
      ? await listLocalModels(values['base-url'])
      : await new OpenRouterClient({ apiKey: requireKey() }).listModels();
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

  if (command === 'gauntlet') return runGauntletCommand(values);

  if (command !== 'run') {
    usage();
    process.exitCode = 1;
    return;
  }

  const def = games.get(values.game);
  if (!def) throw new Error(`unknown game ${values.game}`);
  const count = Number(values.seats ?? def.minSeats);
  if (!Number.isInteger(count) || count < def.minSeats || count > def.maxSeats) {
    throw new Error(`${def.id} needs ${def.minSeats}..${def.maxSeats} seats`);
  }
  if (values.llm && !values.model) throw new Error('--llm needs --model <id>');

  const seats: Seat[] = Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    name: `Seat ${i + 1}`,
    kind: values.llm ? 'llm' : 'bot',
    ...(values.llm ? { modelId: values.model as string } : {}),
  }));

  const controllers = new Map<string, Controller>();
  if (values.llm) {
    const client = values['base-url']
      ? new OpenAICompatibleClient({ baseUrl: values['base-url'] })
      : new OpenRouterClient({ apiKey: requireKey(), appName: 'GameTable' });
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
    options: { trackOptimality: values.oracle === true },
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
  for (const seat of result.seats) {
    const metrics = seat.metrics;
    if (metrics && typeof metrics.decisions === 'number' && metrics.decisions > 0) {
      console.log(
        `${seat.name}: EV loss ${metrics.evLoss} over ${metrics.decisions} decisions ` +
          `(${metrics.evLossPerDecision} per decision)`,
      );
    }
  }

  await new ResultsStore(resolve(values.file)).append(toRecord(result));
}

async function runGauntletCommand(values: {
  models?: string | undefined;
  oracle: boolean;
  seed?: string | undefined;
}): Promise<void> {
  const names = values.models
    ? values.models.split(',').map((name) => name.trim()).filter(Boolean)
    : ['bot-1', 'bot-2', 'bot-3'];
  const seed = values.seed ? Number(values.seed) : 4242;
  const useLlm = Boolean(values.models);
  const client = useLlm
    ? new OpenRouterClient({ apiKey: requireKey(), appName: 'GameTable' })
    : null;

  const hero: Seat = { id: 'hero', name: 'You', kind: 'bot' };
  const opponents = names.map((name, index) => {
    const seat: Seat = {
      id: `opp${index + 1}`,
      name,
      kind: useLlm ? 'llm' : 'bot',
      ...(useLlm ? { modelId: name } : {}),
    };
    const controller: Controller = client
      ? new LlmController({
          client,
          gameName: 'Buckshot Roulette',
          config: { model: name, temperature: 0.8 },
        })
      : new RandomBot(101 + index);
    return { seat, controller };
  });

  const result = await runGauntlet({
    hero,
    heroController: new RandomBot(1),
    opponents,
    seed,
    trackOptimality: values.oracle,
    onDuel: (duel, index) => {
      const heroWon = duel.result.winners.includes('hero');
      console.log(
        `duel ${index + 1}: vs ${duel.opponent.name.padEnd(36)} ` +
          `${heroWon ? 'win ' : 'loss'} ${duel.result.scores.hero ?? 0}-${
            duel.result.scores[duel.opponent.id] ?? 0
          }  carried ${duel.carried.length}`,
      );
    },
  });

  console.log(
    `\ngauntlet: ${result.duelsWon}/${result.duels.length} duels, ` +
      `${result.roundWins} rounds won, $${result.totalCostUsd.toFixed(4)}`,
  );
}

function requireKey(): string {  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('set OPENROUTER_API_KEY first');
  return key;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
