import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          fileParallelism: false,
          // World import, replay, and schema fixtures exercise correctness under shared CPU load.
          // Timing requirements use explicit assertions rather than the runner's failure budget.
          testTimeout: 30_000,
          include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
          setupFiles: ["./test/setup.ts"],
        },
      },
    ],
  },
});
