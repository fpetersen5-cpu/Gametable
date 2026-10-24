import type { GameAction, GameView } from '../../shared/api';
import { buckshotData, coupData, mafiaData } from '../game-data';
import { ActionPanel } from './ActionPanel';
import { BuckshotPanel } from './BuckshotPanel';
import { ChatLog } from './ChatLog';
import { CoupPanel } from './CoupPanel';
import { MafiaLog, MafiaPanel } from './MafiaPanel';
import { SeatRing } from './SeatRing';

interface Props {
  view: GameView;
  godView: GameView | null;
  humanSeatId: string | null;
  spectator: boolean;
  awaiting: boolean;
  previews?: Record<string, string>;
  onAction?: (action: GameAction) => void;
  controlledSeats?: string[];
  onTakeover?: (seatId: string) => void;
  onRelease?: (seatId: string) => void;
}

/**
 * Generic table. Game-specific panels are chosen by the *shape* of the view
 * data and declared capabilities, never by a hard-coded game id.
 */
export function GameTable({
  view,
  godView,
  humanSeatId,
  spectator,
  awaiting,
  previews,
  onAction,
  controlledSeats,
  onTakeover,
  onRelease,
}: Props) {
  const shown = spectator && godView ? godView : view;
  const mafia = mafiaData(shown);
  const buck = buckshotData(shown);
  const coup = coupData(shown);
  const coupRoles = coup?.god
    ? Object.fromEntries(
        Object.entries(coup.god.hands).map(([id, hand]) => [id, hand.join(' + ')]),
      )
    : null;
  const showActions = Boolean(onAction) && !spectator;

  return (
    <div className="game-table">
      <SeatRing
        seats={shown.seats}
        phase={shown.phase}
        humanSeatId={humanSeatId}
        roles={mafia?.god?.roles ?? buck?.publicRoles ?? coupRoles ?? null}
        yourRole={mafia?.yourRole ?? coup?.yourRole ?? null}
        thinking={awaiting}
        controlledSeats={controlledSeats}
        onTakeover={onTakeover}
        onRelease={onRelease}
      />

      <div className={`table-body${showActions ? '' : ' solo'}`}>
        <div className="table-main">
          {mafia && <MafiaPanel data={mafia} seats={shown.seats} />}
          {buck && (
            <BuckshotPanel
              data={buck}
              spectator={spectator}
              seats={shown.seats}
              viewSeatId={shown.seatId}
              humanSeatId={humanSeatId}
            />
          )}
          {coup && <CoupPanel data={coup} seats={shown.seats} />}
          {!mafia && !buck && !coup && (
            <pre className="raw-state">{JSON.stringify(shown.data, null, 2)}</pre>
          )}
          {(shown.chat.length > 0 || Object.keys(previews ?? {}).length > 0) && (
            <ChatLog chat={shown.chat} seats={shown.seats} previews={previews} />
          )}
          {mafia && <MafiaLog data={mafia} />}
        </div>

        {showActions && (
          <aside className="table-side">
            <ActionPanel view={view} awaiting={awaiting} onAction={onAction as (a: GameAction) => void} />
            <div className="side-note">
              <h4>Seat knowledge</h4>
              <p className="muted">
                You only see what this seat is allowed to see. The models get the same
                projection you do — nothing more.
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
