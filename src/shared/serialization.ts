export async function serializeByKey<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  locks.set(key, chain);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}
