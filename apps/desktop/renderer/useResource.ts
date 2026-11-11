import { useEffect, useState } from 'react';
import { errorMessage, withTimeout } from './async';

/** Callers memoize load; cleanup prevents old requests from replacing newer data. */
export function useResource<T>(load: () => Promise<T>, label: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    load: () => Promise<T>; attempt: number; data: T | null; error: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void withTimeout(Promise.resolve().then(load), label).then(
      (data) => { if (active) setResult({ load, attempt, data, error: null }); },
      (reason) => { if (active) setResult({ load, attempt, data: null, error: errorMessage(reason) }); },
    );
    return () => { active = false; };
  }, [load, label, attempt]);
  // Hide the previous selection immediately, before its effect cleanup runs.
  const current = result?.load === load && result.attempt === attempt ? result : null;
  return { data: current?.data ?? null, loading: current === null,
    error: current?.error ?? null, retry: () => setAttempt((value) => value + 1) };
}
