/** A function that runs `task` once fewer than `max` tasks started through it are still pending. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Tiny concurrency limiter (no deps). Wrap individual API calls with it, not compound tasks that
 * themselves go through the same limiter — a task waiting on a nested slot could deadlock.
 */
export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve().then(task).then(resolve, reject).finally(next);
      };
      if (active < max) run();
      else queue.push(run);
    });
}
