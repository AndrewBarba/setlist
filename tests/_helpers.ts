/**
 * Test helpers — a thin compatibility shim over `node:test` and
 * `node:assert/strict`.
 *
 * The function names mirror the `@std/assert` API we previously used so
 * that each test file is a near-mechanical conversion: change the import
 * line, change `Deno.test` to `test`, change `t.step` to `t.test`, and
 * the rest of the test body is unchanged.
 *
 * Keeping the shim in one place also makes it easy to swap the underlying
 * runner later (e.g., to Vitest) — only this file changes.
 */
import assertNs from "node:assert/strict";

export { test } from "node:test";

/**
 * Assert a value is truthy. Equivalent to `node:assert`'s default-export
 * call but named for parity with the prior `@std/assert` style.
 */
export function assert(value: unknown, message?: string): asserts value {
  assertNs.ok(value, message);
}

/**
 * Assert a value is falsy. The inverse of {@link assert}.
 */
export function assertFalse(value: unknown, message?: string): void {
  assertNs.ok(!value, message);
}

/**
 * Deep structural equality. Backs `@std/assert`'s `assertEquals` semantics
 * with Node's `deepStrictEqual` (handles arrays, objects, nested values).
 */
export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  assertNs.deepStrictEqual(actual, expected, message);
}

/**
 * Approximate numeric equality. `@std/assert`'s default epsilon was
 * `1e-7`; we preserve it so existing tolerance expectations carry over
 * unchanged.
 */
export function assertAlmostEquals(
  actual: number,
  expected: number,
  epsilon = 1e-7,
  message?: string,
): void {
  const delta = Math.abs(actual - expected);
  if (delta <= epsilon) return;
  const detail = `${actual} ≈ ${expected} failed (delta ${delta} > ${epsilon})`;
  assertNs.fail(message ? `${message}: ${detail}` : detail);
}

/**
 * Assert that a function throws, optionally constrained by error class
 * and/or a substring of the error message.
 *
 * Mirrors `@std/assert`'s `assertThrows(fn, ErrorClass?, msgIncludes?)`
 * signature and returns the thrown error for further inspection.
 */
export function assertThrows(
  fn: () => unknown,
  ErrorClass?: new (...args: never[]) => Error,
  msgIncludes?: string,
): Error {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (thrown === undefined) {
    assertNs.fail("Expected function to throw, but it returned normally");
  }
  if (ErrorClass && !(thrown instanceof ErrorClass)) {
    const got = (thrown as { constructor?: { name?: string } })?.constructor
      ?.name ?? typeof thrown;
    assertNs.fail(
      `Expected thrown error to be instance of ${ErrorClass.name}, got ${got}`,
    );
  }
  if (msgIncludes !== undefined) {
    const message = (thrown as Error)?.message ?? "";
    if (!message.includes(msgIncludes)) {
      assertNs.fail(
        `Expected error message to include ${JSON.stringify(msgIncludes)}, got ${
          JSON.stringify(message)
        }`,
      );
    }
  }
  return thrown as Error;
}
