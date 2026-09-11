import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/** Reuse the owned mechanism scenarios instead of inventing another world or
 * copying their expected Truth, belief, resource and replay assertions. */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node", fileParallelism: false,
    include: [
      "src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts",
      "src/engine/mechanics/**/*.test.ts", "src/engine/cognition/**/*.test.ts",
      "src/engine/runtime/**/*.test.ts", "src/engine/benchmarks/causal-activity-benchmark.test.ts",
    ],
    setupFiles: ["./test/setup.ts", "./scripts/experiments/ac-fp1-mechanisms.setup.ts"],
  },
});
