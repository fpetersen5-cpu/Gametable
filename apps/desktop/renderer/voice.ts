import { useEffect, useRef } from 'react';
import type { ChatLine } from '../shared/api';

interface Options {
  matchId: string;
  chat: ChatLine[];
  humanSeatId: string | null;
  enabled: boolean;
}

/**
 * Reads model messages aloud, one per seat, with a queue so overlapping turns
 * do not talk over each other. The human's own lines are never read back.
 */
export function useSeatVoices({ matchId, chat, humanSeatId, enabled }: Options): void {
  const spoken = useRef(new Set<string>());
  const matchRef = useRef('');
  const pending = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const audio = useRef<HTMLAudioElement | null>(null);
  const wasEnabled = useRef(enabled);

  useEffect(() => {
    if (matchRef.current !== matchId) {
      matchRef.current = matchId;
      spoken.current = new Set();
      wasEnabled.current = enabled;
    }

    if (!enabled) {
      wasEnabled.current = false;
      audio.current?.pause();
      return;
    }

    // Turning voice on mid-match should not replay the backlog.
    if (!wasEnabled.current) {
      for (const line of chat) spoken.current.add(line.id);
      wasEnabled.current = true;
      return;
    }

    for (const line of chat) {
      if (spoken.current.has(line.id)) continue;
      spoken.current.add(line.id);
      if (line.channel !== 'public') continue;
      if (line.seatId === humanSeatId) continue;
      if (pending.current >= 3) continue;

      const text = line.text;
      const seatId = line.seatId;
      pending.current += 1;
      chain.current = chain.current.then(async () => {
        try {
          const result = await window.gametable.speak(text, seatId);
          if (!result.audio) return;
          await new Promise<void>((resolve) => {
            const player = new Audio(`data:audio/wav;base64,${result.audio}`);
            audio.current = player;
            player.onended = () => resolve();
            player.onerror = () => resolve();
            void player.play().catch(() => resolve());
          });
        } finally {
          pending.current -= 1;
        }
      });
    }
  }, [chat, enabled, humanSeatId, matchId]);

  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );
}
