import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  dependencies: readonly unknown[]
): AsyncState<T> {
  const [state, setState] = useState<Omit<AsyncState<T>, "reload">>({
    loading: true
  });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => {
      const next: Omit<AsyncState<T>, "reload"> = { loading: true };
      if (current.data !== undefined) next.data = current.data;
      return next;
    });
    void load(controller.signal).then(
      (data) => setState({ data, loading: false }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            error: error instanceof Error ? error : new Error("Request failed."),
            loading: false
          });
        }
      }
    );
    return () => controller.abort();
    // The caller controls the dependency list to keep fetch identity explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision]);

  return {
    ...state,
    reload: () => setRevision((value) => value + 1)
  };
}
