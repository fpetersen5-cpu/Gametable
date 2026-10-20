import type { SeatInfo } from '../../shared/api';
import { ROLE_GLYPH, seatColor } from '../game-data';
import type { MafiaRole } from '../game-data';

export function MafiaPanel({ data, seats }: { data: MafiaRole; seats: SeatInfo[] }) {
  const name = (id: string) => seats.find((seat) => seat.id === id)?.name ?? id;
  const voteCounts = new Map<string, number>();
  for (const vote of data.votes) {
    voteCounts.set(vote.target, (voteCounts.get(vote.target) ?? 0) + 1);
  }

  return (
    <div className="mafia-panel">
      {data.yourRole ? (
        <div className={`role-card role-${data.yourRole}`}>
          <span className="role-glyph">{ROLE_GLYPH[data.yourRole] ?? '🎭'}</span>
          <div>
            <strong>{data.yourRole.toUpperCase()}</strong>
            <p>{data.yourRoleText}</p>
            {data.teammates.length > 0 && (
              <small>Partners: {data.teammates.map(name).join(', ')}</small>
            )}
          </div>
        </div>
      ) : (
        <div className="role-card spectator">
          <span className="role-glyph">👁</span>
          <div>
            <strong>Omniscient view</strong>
            <p>Every role and private channel is revealed for this view.</p>
          </div>
        </div>
      )}

      <div className="log-panel">
        <h4>What happened</h4>
        <ul>
          {data.log.map((line, index) => (
            <li key={`${index}-${line.slice(0, 12)}`}>{line}</li>
          ))}
        </ul>
      </div>

      {(data.votes.length > 0 || data.runoff.length > 0) && (
        <div className="vote-panel">
          <h4>Votes {data.runoff.length > 0 && <span className="pill warn">runoff</span>}</h4>
          <div className="vote-rows">
            {data.votes.map((vote) => (
              <div key={vote.voter} className="vote-row">
                <span style={{ color: seatColor(vote.voter) }}>{vote.voterName}</span>
                <span className="vote-arrow">→</span>
                <span style={{ color: seatColor(vote.target) }}>{vote.targetName}</span>
              </div>
            ))}
          </div>
          {data.votes.length === 0 && data.runoff.length > 0 && (
            <p className="muted vote-runoff">
              Runoff between {data.runoff.map(name).join(' and ')}.
            </p>
          )}
          {voteCounts.size > 0 && (
            <div className="vote-counts">
              {[...voteCounts.entries()].map(([target, count]) => (
                <span key={target} className="vote-count">
                  {name(target)} <strong>{count}</strong>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {data.checks.length > 0 && (
        <div className="checks-panel">
          <h4>Your investigations</h4>
          {data.checks.map((check) => (
            <div key={check.target} className="check-row">
              <span>{check.targetName}</span>
              <span className={`pill ${check.result === 'mafia' ? 'danger' : 'safe'}`}>
                {check.result}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
