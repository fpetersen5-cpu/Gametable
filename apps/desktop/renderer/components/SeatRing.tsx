import type { CSSProperties } from 'react';
import type { Phase, SeatInfo } from '../../shared/api';
import { ROLE_GLYPH, seatColor, shortModel } from '../game-data';

interface Props {
  seats: SeatInfo[];
  phase: Phase;
  humanSeatId: string | null;
  /** Roles known to the viewer (all roles for spectators). */
  roles: Record<string, string> | null;
  yourRole: string | null;
  /** False in replays: nobody is thinking. */
  thinking?: boolean;
}

export function SeatRing({ seats, phase, humanSeatId, roles, yourRole, thinking }: Props) {
  return (
    <div className="seat-ring">
      {seats.map((seat) => {
        const acting = phase.actors.includes(seat.id);
        const dead = seat.alive === false;
        const role = roles?.[seat.id] ?? (seat.id === humanSeatId ? yourRole : null);
        const color = seatColor(seat.id);
        return (
          <div
            key={seat.id}
            className={`ring-seat${acting ? ' acting' : ''}${dead ? ' dead' : ''}${
              seat.id === humanSeatId ? ' you' : ''
            }`}
            style={{ '--seat-color': color } as CSSProperties}
          >
            <div className="ring-top">
              <span className="ring-name">{seat.name}</span>
              {seat.kind === 'human' ? (
                <span className="ring-badge you-badge">YOU</span>
              ) : (
                <span className="ring-badge">AI</span>
              )}
            </div>
            {seat.modelId && <small className="ring-model">{shortModel(seat.modelId)}</small>}
            <div className="ring-bottom">
              {role ? (
                <span className={`ring-role role-${role}`}>
                  {ROLE_GLYPH[role] ?? '•'} {role}
                </span>
              ) : (
                <span className="ring-role muted-role">unknown</span>
              )}
              {dead && <span className="ring-dead">dead</span>}
            </div>
            {acting && thinking !== false && (
              <span className="ring-thinking">
                {seat.id === humanSeatId ? 'your move' : 'thinking…'}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
