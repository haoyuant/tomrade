/** An error's message, or what was thrown as text. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Any logger with a debug level, a cordis one among them. */
export interface DebugLogger {
  debug(message: string): void;
}

/**
 * Work whose failure changes nothing for the caller: a failure is logged at
 * debug level, never thrown, and the result is undefined.
 */
export function bestEffort<T>(work: PromiseLike<T>, logger: DebugLogger, what: string): Promise<T | undefined> {
  return Promise.resolve(work).then(undefined, (error: unknown) => {
    logger.debug(`${what}: ${errorMessage(error)}`);
    return undefined;
  });
}
