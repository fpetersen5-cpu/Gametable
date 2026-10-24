import type { SeatInfo } from '../../shared/api';
import { ROLE_GLYPH, seatColor } from '../game-data';
import type { CoupData } from '../game-data';

const ACTION_LABEL: Record<string, string> = {
  income: 'take income',
  'foreign-aid': 'take foreign aid',
  coup: 'launch a coup',
  assassinate: 'assassinate',
  steal: 'steal',
  tax: 'collect tax',
  exchange: 'exchange cards',
};

function actionText(data: CoupData): string | null {
  if (!data.pending) return null;
  const verb = ACTION_LABEL[data.pending.type] ?? data.pending.type;
  const target = data.pending.targetName ? ` against ${data.pending.targetName}` : '';
  const claim = data.pending.claimedRole ? ` claiming ${data.pending.claimedRole}` : '';
  return `${data.pending.actorName} ${verb}${target}${claim}.`;
}

export function CoupPanel({ data, seats }: { data: CoupData; seats: SeatInfo[] }) {
  const name = (id: string) => seats.find((seat) => seat.id === id)?.name ?? id;
  const pending = actionText(data);

  return (
    <div className="coup-panel">
      {data.god ? (
        <div className="role-card spectator">
          <span className="role-glyph">👁</span>
          <div>
            <strong>Omniscient view</strong>
            <p>All hands are revealed for this replay/spectator view.</p>
          </div>
        </div>
      ) : (
        <div className="role-card">
          <span className="role-glyph">
            {data.hand.map((role) => ROLE_GLYPH[role] ?? '🃏').join(' ')}
          </span>
          <div>
            <strong>Your influence ({data.hand.length})</strong>
            <p>{data.hand.length > 0 ? data.hand.join(' · ') : 'No influence left.'}</p>
            <small>{data.coins} coins</small>
          </div>
        </div>
      )}

      {pending && (
        <div className="coup-pending">
          <h4>Action on the table</h4>
          <p>{pending}</p>
          {data.block && (
            <p>
              Block: <strong>{data.block.blockerName}</strong> claims{' '}
              {data.block.role}.
            </p>
          )}
        </div>
      )}

      <div className="coup-players">
        <h4>Coins and influence</h4>
        {data.players.map((player) => {
          const hand = data.god?.hands?.[player.id];
          return (
            <div key={player.id} className={`coup-player${player.alive ? '' : ' out'}`}>
              <span className="coup-player-name" style={{ color: seatColor(player.id) }}>
                {name(player.id)}
                {!player.alive && <span className="pill danger">out</span>}
              </span>
              <span className="coup-player-stats">
                <span className="coin-count">🪙 {player.coins}</span>
                <span className="influence-count">
                  🃏 {player.influence}
                  {hand && hand.length > 0 && ` (${hand.join(' · ')})`}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      {data.exchangeCards && data.exchangeCards.length > 0 && (
        <div className="coup-exchange">
          <h4>
            Choose {data.hand.length === 1 ? 'one card' : 'two cards'} to keep
          </h4>
          <p className="muted">
            You drew {data.exchangeCards.length - data.hand.length} cards. Pick{' '}
            {data.hand.length === 1 ? 'one' : 'two'} of the {data.exchangeCards.length} and
            return the rest to the deck.
          </p>
        </div>
      )}

      {data.discard.length > 0 && (
        <div className="coup-discard">
          <h4>Revealed losses</h4>
          <p>{data.discard.join(' · ')}</p>
        </div>
      )}

      {data.log.length > 0 && (
        <div className="coup-log">
          <h4>Public record</h4>
          {data.log.map((line, index) => (
            <p key={`${index}-${line}`}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
