import fs from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { experimental_readRawConfig } from "wrangler";
import { defineConfig } from "vitest/config";

/**
 * All tests run inside workerd via @cloudflare/vitest-pool-workers, against
 * the real wrangler.jsonc bindings (Durable Object, Workflow, D1, rate
 * limiters), with ONE substitution: the remote Workers AI binding is replaced
 * by a scripted fake (test/fixtures/fake-ai.mjs), so tests are hermetic,
 * free and deterministic. No production code path checks for "test mode".
 *
 * A remote `ai` binding in wrangler config always wins over a miniflare
 * override, so we derive a test copy of wrangler.jsonc with only `ai`
 * removed. wrangler.jsonc stays the single source of truth for everything else.
 */
const root = import.meta.dirname;

/** The subset of wrangler config this file rewrites. */
interface RawConfig {
  main?: string;
  ai?: unknown;
  assets?: { directory?: string } & Record<string, unknown>;
  d1_databases?: ({ migrations_dir?: string } & Record<string, unknown>)[];
  [key: string]: unknown;
}

function writeTestWranglerConfig(): string {
  // wrangler's config types don't resolve under the lint project; the result is typed via RawConfig.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const raw = experimental_readRawConfig({ config: path.join(root, "wrangler.jsonc") }) as {
    rawConfig: RawConfig;
  };
  const config = { ...raw.rawConfig };
  delete config.ai;
  const abs = (p: string) => path.resolve(root, p);
  const testConfig = {
    ...config,
    main: abs(String(config.main)),
    assets: config.assets
      ? { ...config.assets, directory: abs(String(config.assets.directory)) }
      : undefined,
    d1_databases: config.d1_databases?.map((d) => ({
      ...d,
      migrations_dir: d.migrations_dir ? abs(d.migrations_dir) : undefined,
    })),
  };
  const dir = path.join(root, ".wrangler", "test");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wrangler.test.json");
  fs.writeFileSync(file, JSON.stringify(testConfig, null, 2));
  return file;
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: writeTestWranglerConfig() },
        remoteBindings: false,
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          serviceBindings: { AI: { name: "fake-ai" } },
          workers: [
            {
              name: "fake-ai",
              modules: true,
              compatibilityDate: "2026-08-15",
              scriptPath: path.join(root, "test/fixtures/fake-ai.mjs"),
            },
          ],
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      testTimeout: 20_000,
    },
  };
});
