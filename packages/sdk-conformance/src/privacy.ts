import type { GameDef, SeatId } from '@gametable/engine';
import { actionSchema, buildSystemPrompt, buildUserPrompt } from '@gametable/agent';

/**
 * Compare two worlds which differ ONLY in information hidden from this seat.
 * Game authors supply valid pairs: public facts and the seat's knowledge must
 * stay fixed. Unlike synthetic secret labels, this catches raw state exposure
 * in data, phase actors, legal actions, chat, briefings and model requests.
 * Never print the differing payloads: they may contain private information.
 */
export function assertViewNonInterference<S>(
  def: GameDef<S>, seatId: SeatId, before: S, after: S,
): void {
  const project = (state: S) => {
    const view = def.view(state, seatId);
    const seat = view.seats.find((entry) => entry.id === seatId);
    if (!seat) throw new Error('Privacy fixture is missing the viewing seat');
    return {
      view,
      briefing: def.briefing(state, seatId),
      system: buildSystemPrompt({
        gameName: def.name, seat, briefing: view.briefing, legalActions: view.legalActions,
      }),
      messages: buildUserPrompt({
        view, seatNames: new Map(view.seats.map((entry) => [entry.id, entry.name])), memoryNotes: '',
      }),
      schema: actionSchema(view.legalActions),
    };
  };
  if (JSON.stringify(project(before)) !== JSON.stringify(project(after))) {
    throw new Error(`Hidden information affected the view or model request for ${seatId}`);
  }
}
