/**
 * Temporary subset of the native Temporal API used by core.
 *
 * Node.js 26 provides Temporal at runtime, but TypeScript does not include its
 * declarations yet. Remove this once TypeScript ships the standard definitions.
 */
declare namespace Temporal {
  interface DurationLike {
    readonly minutes?: number;
  }

  interface Instant {
    readonly epochMilliseconds: number;

    add(duration: DurationLike): Instant;
  }

  namespace Now {
    function instant(): Instant;
  }
}
