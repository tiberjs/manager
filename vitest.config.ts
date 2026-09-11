import { existsSync, readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "vitest/config";

const packagesRoot = new URL("./packages/", import.meta.url);
const packages = readdirSync(packagesRoot, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && existsSync(new URL(`${entry.name}/package.json`, packagesRoot)),
  )
  .map((entry) => {
    const manifest = JSON.parse(
      readFileSync(new URL(`${entry.name}/package.json`, packagesRoot), "utf8"),
    ) as { name: string };

    return { directory: entry.name, name: manifest.name };
  })
  .sort((a, b) => a.directory.localeCompare(b.directory));

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ["tiberjs-source"],
    },
  },
  test: {
    environment: "node",
    pool: "forks",
    restoreMocks: true,
    projects: packages.map(({ directory, name }) => ({
      extends: true,
      test: {
        name,
        include: [`packages/${directory}/tests/**/*.test.ts`],
      },
    })),
  },
});
