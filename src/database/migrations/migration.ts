import { logger } from '../utils/logger';
import { MongoDBConnection } from './mongodb';

export interface Migration {
  id: string;
  name: string;
  version: string;
  description: string;
  up: (db: mongoose.mongo.Db) => Promise<void>;
  down: (db: mongoose.mongo.Db) => Promise<void>;
  dependencies?: string[];
}

export interface MigrationRecord {
  _id: string;
  id: string;
  name: string;
  version: string;
  description: string;
  executedAt: Date;
  executionTime: number;
  success: boolean;
  error?: string;
}

export class MigrationManager {
  private db: mongoose.mongo.Db | null = null;
  private migrations: Migration[] = [];
  private collectionName = 'migrations';

  constructor(private mongoConnection: MongoDBConnection) {}

  public async initialize(): Promise<void> {
    try {
      const connection = this.mongoConnection.getConnection();
      if (!connection) {
        throw new Error('MongoDB not connected');
      }

      this.db = connection.db;

      // Create migrations collection if it doesn't exist
      await this.createMigrationsCollection();

      // Create indexes for migrations collection
      await this.db
        .collection(this.collectionName)
        .createIndex({ id: 1 }, { unique: true });

      await this.db
        .collection(this.collectionName)
        .createIndex({ executedAt: 1 });

      logger.info('Migration manager initialized');
    } catch (error) {
      logger.error('Failed to initialize migration manager', error);
      throw error;
    }
  }

  public registerMigration(migration: Migration): void {
    // Check if migration with same ID already exists
    const existingIndex = this.migrations.findIndex(m => m.id === migration.id);
    if (existingIndex !== -1) {
      this.migrations[existingIndex] = migration;
    } else {
      this.migrations.push(migration);
    }

    // Sort migrations by version (semantic versioning)
    this.migrations.sort((a, b) => this.compareVersions(a.version, b.version));
  }

  public async migrate(
    options: {
      targetVersion?: string;
      force?: boolean;
      dryRun?: boolean;
    } = {}
  ): Promise<{
    executed: Migration[];
    skipped: Migration[];
    failed: Migration[];
    errors: string[];
  }> {
    if (!this.db) {
      throw new Error('Migration manager not initialized');
    }

    const { targetVersion, force = false, dryRun = false } = options;
    const executed: Migration[] = [];
    const skipped: Migration[] = [];
    const failed: Migration[] = [];
    const errors: string[] = [];

    logger.info('Starting database migration', {
      targetVersion,
      force,
      dryRun,
    });

    try {
      // Get executed migrations
      const executedMigrations = await this.getExecutedMigrations();
      const executedIds = new Set(executedMigrations.map(m => m.id));

      // Filter migrations to run
      const migrationsToRun = this.migrations.filter(migration => {
        if (executedIds.has(migration.id)) {
          return false;
        }

        if (
          targetVersion &&
          this.compareVersions(migration.version, targetVersion) > 0
        ) {
          return false;
        }

        return true;
      });

      // Check dependencies
      const dependencyErrors = await this.checkDependencies(
        migrationsToRun,
        executedIds
      );
      if (dependencyErrors.length > 0) {
        errors.push(...dependencyErrors);
        if (!force) {
          throw new Error(
            `Migration dependencies not satisfied: ${dependencyErrors.join(', ')}`
          );
        }
      }

      logger.info(`Found ${migrationsToRun.length} migrations to run`);

      // Execute migrations
      for (const migration of migrationsToRun) {
        try {
          logger.info(`Running migration: ${migration.name} (${migration.id})`);

          if (dryRun) {
            logger.info(`[DRY RUN] Would execute migration: ${migration.name}`);
            executed.push(migration);
            continue;
          }

          const startTime = Date.now();

          // Record migration start
          await this.recordMigrationStart(migration);

          // Execute migration
          await migration.up(this.db);

          const executionTime = Date.now() - startTime;

          // Record successful migration
          await this.recordMigrationSuccess(migration, executionTime);

          executed.push(migration);
          logger.info(
            `Migration completed: ${migration.name} (${executionTime}ms)`
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Migration ${migration.id} failed: ${errorMessage}`);

          // Record failed migration
          await this.recordMigrationFailure(migration, errorMessage);

          failed.push(migration);
          logger.error(`Migration failed: ${migration.name}`, error);

          if (!force) {
            throw new Error(
              `Migration ${migration.id} failed: ${errorMessage}`
            );
          }
        }
      }

      const result = {
        executed,
        skipped: this.migrations.filter(
          m => !executed.includes(m) && !failed.includes(m)
        ),
        failed,
        errors,
      };

      logger.info('Migration completed', {
        executed: executed.length,
        skipped: result.skipped.length,
        failed: failed.length,
        errors: errors.length,
      });

      return result;
    } catch (error) {
      logger.error('Migration process failed', error);
      throw error;
    }
  }

  public async rollback(
    options: {
      targetVersion?: string;
      steps?: number;
      force?: boolean;
      dryRun?: boolean;
    } = {}
  ): Promise<{
    rolledBack: Migration[];
    failed: Migration[];
    errors: string[];
  }> {
    if (!this.db) {
      throw new Error('Migration manager not initialized');
    }

    const { targetVersion, steps, force = false, dryRun = false } = options;
    const rolledBack: Migration[] = [];
    const failed: Migration[] = [];
    const errors: string[] = [];

    logger.info('Starting database rollback', {
      targetVersion,
      steps,
      force,
      dryRun,
    });

    try {
      // Get executed migrations in reverse order
      const executedMigrations = await this.getExecutedMigrations();
      const executedMigrationsDesc = executedMigrations.sort((a, b) =>
        this.compareVersions(b.version, a.version)
      );

      // Determine migrations to rollback
      let migrationsToRollback: MigrationRecord[] = [];

      if (targetVersion) {
        migrationsToRollback = executedMigrationsDesc.filter(
          m => this.compareVersions(m.version, targetVersion) > 0
        );
      } else if (steps) {
        migrationsToRollback = executedMigrationsDesc.slice(0, steps);
      } else {
        // Default: rollback last migration
        migrationsToRollback = executedMigrationsDesc.slice(0, 1);
      }

      logger.info(
        `Found ${migrationsToRollback.length} migrations to rollback`
      );

      // Execute rollbacks
      for (const migrationRecord of migrationsToRollback) {
        const migration = this.migrations.find(
          m => m.id === migrationRecord.id
        );
        if (!migration) {
          const error = `Migration definition not found for: ${migrationRecord.id}`;
          errors.push(error);
          continue;
        }

        try {
          logger.info(
            `Rolling back migration: ${migration.name} (${migration.id})`
          );

          if (dryRun) {
            logger.info(
              `[DRY RUN] Would rollback migration: ${migration.name}`
            );
            rolledBack.push(migration);
            continue;
          }

          // Execute rollback
          await migration.down(this.db);

          // Remove migration record
          await this.db
            .collection(this.collectionName)
            .deleteOne({ id: migration.id });

          rolledBack.push(migration);
          logger.info(`Rollback completed: ${migration.name}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Rollback ${migration.id} failed: ${errorMessage}`);
          failed.push(migration);
          logger.error(`Rollback failed: ${migration.name}`, error);

          if (!force) {
            throw new Error(`Rollback ${migration.id} failed: ${errorMessage}`);
          }
        }
      }

      const result = {
        rolledBack,
        failed,
        errors,
      };

      logger.info('Rollback completed', {
        rolledBack: rolledBack.length,
        failed: failed.length,
        errors: errors.length,
      });

      return result;
    } catch (error) {
      logger.error('Rollback process failed', error);
      throw error;
    }
  }

  public async getMigrationStatus(): Promise<{
    pending: Migration[];
    executed: MigrationRecord[];
    total: number;
  }> {
    if (!this.db) {
      throw new Error('Migration manager not initialized');
    }

    const executed = await this.getExecutedMigrations();
    const executedIds = new Set(executed.map(m => m.id));
    const pending = this.migrations.filter(m => !executedIds.has(m.id));

    return {
      pending,
      executed,
      total: this.migrations.length,
    };
  }

  private async createMigrationsCollection(): Promise<void> {
    if (!this.db) return;

    const collections = await this.db.listCollections().toArray();
    const exists = collections.some(c => c.name === this.collectionName);

    if (!exists) {
      await this.db.createCollection(this.collectionName);
      logger.info(`Created migrations collection: ${this.collectionName}`);
    }
  }

  private async getExecutedMigrations(): Promise<MigrationRecord[]> {
    if (!this.db) return [];

    const cursor = this.db
      .collection<MigrationRecord>(this.collectionName)
      .find({ success: true })
      .sort({ executedAt: 1 });

    return await cursor.toArray();
  }

  private async checkDependencies(
    migrations: Migration[],
    executedIds: Set<string>
  ): Promise<string[]> {
    const errors: string[] = [];

    for (const migration of migrations) {
      if (migration.dependencies) {
        for (const dep of migration.dependencies) {
          if (!executedIds.has(dep)) {
            errors.push(
              `Migration ${migration.id} depends on ${dep} which has not been executed`
            );
          }
        }
      }
    }

    return errors;
  }

  private async recordMigrationStart(migration: Migration): Promise<void> {
    if (!this.db) return;

    await this.db.collection(this.collectionName).insertOne({
      _id: `${migration.id}_${Date.now()}`,
      id: migration.id,
      name: migration.name,
      version: migration.version,
      description: migration.description,
      executedAt: new Date(),
      executionTime: 0,
      success: false,
      error: undefined,
    });
  }

  private async recordMigrationSuccess(
    migration: Migration,
    executionTime: number
  ): Promise<void> {
    if (!this.db) return;

    await this.db.collection(this.collectionName).updateOne(
      { id: migration.id, success: false },
      {
        $set: {
          success: true,
          executionTime,
        },
      }
    );
  }

  private async recordMigrationFailure(
    migration: Migration,
    error: string
  ): Promise<void> {
    if (!this.db) return;

    await this.db.collection(this.collectionName).updateOne(
      { id: migration.id, success: false },
      {
        $set: {
          success: false,
          error,
        },
      }
    );
  }

  private compareVersions(version1: string, version2: string): number {
    const v1Parts = version1.split('.').map(Number);
    const v2Parts = version2.split('.').map(Number);

    const maxLength = Math.max(v1Parts.length, v2Parts.length);

    for (let i = 0; i < maxLength; i++) {
      const v1Part = v1Parts[i] || 0;
      const v2Part = v2Parts[i] || 0;

      if (v1Part < v2Part) return -1;
      if (v1Part > v2Part) return 1;
    }

    return 0;
  }
}
