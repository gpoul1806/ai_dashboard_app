import { createApp } from "./app";
import { config } from "./config";
import { createDb } from "./db";
import { llmAvailable } from "./llm/client";
import { Orchestrator } from "./orchestrator";
import { createSandbox, makeHostApi } from "./sandbox";
import { seedDemoFeature } from "./seed";

async function main(): Promise<void> {
  const db = await createDb();
  await seedDemoFeature(db);

  const sandbox = await createSandbox(makeHostApi(db));
  const orchestrator = new Orchestrator(db, sandbox);
  // Re-register any previously-approved capabilities from a persistent store.
  await orchestrator.hydrateSandbox();

  const app = createApp({ db, orchestrator, sandbox });
  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] model: ${config.model}`);
    if (!llmAvailable()) {
      console.warn(
        "[server] ANTHROPIC_API_KEY not set — generation is disabled; the seeded Todo feature still works.",
      );
    }
  });

  const shutdown = async () => {
    await sandbox.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[server] fatal", err);
  process.exit(1);
});
