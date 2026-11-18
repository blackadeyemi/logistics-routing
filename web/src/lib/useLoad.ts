import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/**
 * Loads data on mount and whenever deps change; reload() refetches. Also
 * refetches quietly when something else changed the data, such as a
 * copilot proposal being confirmed ("data:changed" on window).
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await fnRef.current();
      if (mine === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onChange = () => void reload();
    window.addEventListener('data:changed', onChange);
    return () => window.removeEventListener('data:changed', onChange);
  }, [reload]);

  return { data, error, loading, reload, setData };
}
