import type { BuckshotData } from '../game-data';
import { ITEM_LABEL } from '../game-data';

interface Props {
  data: BuckshotData;
  spectator: boolean;
  seats: Array<{ id: string; name: string }>;
  /** Which seat this projection belongs to ('__all__' for the god view). */
  viewSeatId?: string;
  humanSeatId?: string | null;
}

export function BuckshotPanel({ data, spectator, seats, viewSeatId, humanSeatId }: Props) {
  const viewSeat = seats.find((seat) => seat.id === viewSeatId);
  const youSeat = viewSeat ?? seats[0];
  const themSeat = seats.find((seat) => seat.id !== youSeat?.id) ?? seats[1];
  const you = spectator
    ? seats[0]?.name ?? 'Player 1'
    : viewSeatId === humanSeatId
      ? 'You'
      : youSeat?.name ?? 'You';
  const them = spectator
    ? seats[1]?.name ?? 'Player 2'
    : themSeat?.name ?? 'Opponent';
  const [yourHp, theirHp] = data.god?.hp ?? [data.yourHp, data.theirHp];
  const [yourItems, theirItems] = data.god?.items ?? [data.yourItems, []];
  const maxHp = data.maxHp || 1;

  return (
    <div className="buckshot-panel">
      <div className="duel">
        <PlayerBar
          label={you}
          hp={yourHp}
          maxHp={maxHp}
          wins={data.roundWins[0]}
          items={yourItems ?? []}
          showItems
        />
        <div className="duel-middle">
          <div className="chamber">
            <span className="chamber-title">Chamber</span>
            <span className="chamber-count">{data.shells} left</span>
            <div className="chamber-pips">
              {Array.from({ length: data.live }, (_, i) => (
                <span key={`l${i}`} className="pip live" title="live" />
              ))}
              {Array.from({ length: data.blank }, (_, i) => (
                <span key={`b${i}`} className="pip blank" title="blank" />
              ))}
              {data.shells === 0 && <span className="muted">empty</span>}
            </div>
            {data.god && (
              <div className="chamber-order" title="true order, top first">
                {data.god.chamber.map((shell, index) => (
                  <span key={index} className={`order-pip ${shell}`}>
                    {index + 1}
                  </span>
                ))}
              </div>
            )}
            {data.sawed && <span className="pill danger">sawed off · next shot 2</span>}
            {data.youAreHandcuffed && <span className="pill warn">handcuffed</span>}
          </div>
          <div className="round-tracker">
            Round {data.round} · best of 3
          </div>
        </div>
        <PlayerBar
          label={them}
          hp={theirHp}
          maxHp={maxHp}
          wins={data.roundWins[1]}
          items={theirItems}
          showItems={Boolean(data.god)}
          itemCount={data.theirItemCount}
        />
      </div>

      {data.youPeeked.top && !spectator && (
        <div className={`peek ${data.youPeeked.top}`}>
          You peeked: the current shell is <strong>{data.youPeeked.top.toUpperCase()}</strong>
        </div>
      )}
      {data.youPeeked.future.length > 0 && !spectator && (
        <div className="peek future">
          Burner phone:{' '}
          {data.youPeeked.future
            .map((entry) => `shell #${entry.offset + 1} is ${entry.shell}`)
            .join(', ')}
        </div>
      )}

      <div className="log-panel compact">
        <h4>Table log</h4>
        <ul>
          {data.recent.map((line, index) => (
            <li key={`${index}-${line.slice(0, 10)}`}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PlayerBar(props: {
  label: string;
  hp: number;
  maxHp: number;
  wins: number;
  items: string[];
  showItems: boolean;
  itemCount?: number;
}) {
  const pct = Math.max(0, Math.min(100, (props.hp / props.maxHp) * 100));
  return (
    <div className="player-bar">
      <div className="player-head">
        <strong>{props.label}</strong>
        <span className="player-wins">{'★'.repeat(props.wins)}</span>
      </div>
      <div className="hp-bar">
        <div
          className={`hp-fill${pct <= 25 ? ' low' : ''}`}
          style={{ width: `${pct}%` }}
        />
        <span className="hp-text">
          {Math.max(0, props.hp)} / {props.maxHp}
        </span>
      </div>
      <div className="belt">
        {props.showItems ? (
          props.items.length === 0 ? (
            <span className="muted">no items</span>
          ) : (
            props.items.map((item, index) => (
              <span key={`${item}-${index}`} className="belt-item" title={ITEM_LABEL[item]?.text}>
                {ITEM_LABEL[item]?.glyph ?? '•'} {ITEM_LABEL[item]?.name ?? item}
              </span>
            ))
          )
        ) : (
          <span className="muted">
            {props.itemCount ?? 0} item{(props.itemCount ?? 0) === 1 ? '' : 's'} (hidden)
          </span>
        )}
      </div>
    </div>
  );
}
