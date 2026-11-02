import 'reflect-metadata';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '@/config/app-config';
import { Migration20261031000001InitialSchema } from './migrations/Migration20261031000001_initial_schema';
import { ALL_SCHEMAS } from './schemas/records';

/** Explicit list instead of filesystem discovery: works the same under Bun, tests and Docker. */
export const MIGRATIONS = [
  { name: 'Migration20261031000001_initial_schema', class: Migration20261031000001InitialSchema },
];

export function createOrmConfig(
  database: Pick<AppConfig['database'], 'url' | 'poolMin' | 'poolMax'>,
) {
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: database.url,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    forceUtcTimezone: true,
    // Every use case works on its own fork(); the global EntityManager must never be used by accident.
    allowGlobalContext: false,
    pool: { min: database.poolMin, max: database.poolMax },
    debug: false,
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
