import { expect, test } from "vitest";
import { FailureReporter } from "../src/failures/reporter.js";

/**
 * The unreported path rethrows in a microtask, which reaches the process as an
 * uncaught exception. Swap the handlers so the expectation observes it.
 */
async function captureRethrown(report: () => void): Promise<unknown[]> {
  const captured: unknown[] = [];
  const installed = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", (error) => {
    captured.push(error);
  });
  const drained = Promise.withResolvers<void>();
  try {
    report();
    setImmediate(drained.resolve);
    await drained.promise;
  } finally {
    process.removeAllListeners("uncaughtException");
    for (const listener of installed) {
      process.on("uncaughtException", listener);
    }
  }

  return captured;
}

test("a reporter that threw is still used by the reports that follow", async () => {
  const first = new Error("first");
  const second = new Error("second");
  const reporterFailure = new Error("reporter failed");
  const seen: { error: unknown; event: string }[] = [];
  const reporter = new FailureReporter({
    onError(error, context) {
      seen.push({ error, event: context.event });
      if (error === first) {
        throw reporterFailure;
      }
    },
  });

  const rethrown = await captureRethrown(() => {
    reporter.report("changed", [first]);
    reporter.report("other", [second]);
  });

  expect(seen).toHaveLength(2);
  expect(seen[0]?.error).toBe(first);
  expect(seen[0]?.event).toBe("changed");
  expect(seen[1]?.error).toBe(second);
  expect(seen[1]?.event).toBe("other");
  expect(rethrown).toStrictEqual([first, reporterFailure]);
});
