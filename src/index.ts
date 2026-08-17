import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';

async function main() {
  const app = createApp();

  app.listen(env.port, () => {
    console.log(`[server] Northern Province Governance API running on http://localhost:${env.port}`);
    console.log(`[server] Environment: ${env.nodeEnv}`);
  });
}

main()
  .catch((err) => {
    console.error('[server] failed to start', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
