import type { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '@/config/app-config';
import { createOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';

/**
 * bun scripts/migrate.ts up | down [steps|all] | status
 * `down` reverts the last migration by default; `down all` reverts everything.
 */
async function main(): Promise<void> {
  const [command = 'status', argument] = process.argv.slice(2);
  const config = loadConfig();
  const orm = await MikroORM.init(createOrmConfig(config.database));
  const migrator = orm.migrator as Migrator;
  try {
    switch (command) {
      case 'up': {
        const done = await migrator.up();
        console.log(
          `applied ${done.length} migration(s): ${done.map((m) => m.name).join(', ') || '-'}`,
        );
        break;
      }
      case 'down': {
        const done = argument === 'all' ? await migrator.down({ to: 0 }) : await migrator.down();
        console.log(
          `reverted ${done.length} migration(s): ${done.map((m) => m.name).join(', ') || '-'}`,
        );
        break;
      }
      case 'status': {
        const [executed, pending] = await Promise.all([
          migrator.getExecuted(),
          migrator.getPending(),
        ]);
        console.log(`executed: ${executed.map((m) => m.name).join(', ') || '-'}`);
        console.log(`pending:  ${pending.map((m) => m.name).join(', ') || '-'}`);
        break;
      }
      default:
        throw new Error(`unknown command "${command}" (use up | down [all] | status)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
