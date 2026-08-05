import type { PathLike } from 'node:fs';
import { backup as backupDatabase, DatabaseSync, type BackupOptions, type SQLTagStore } from 'node:sqlite';

import { assertIntegerInRange, isPathLike, isPromiseLike } from '../utils/global.js';

export const SQLITE_JOURNAL_MODES = {
  DELETE: 'delete',
  WAL: 'wal',
} as const;

export const SQLITE_TRANSACTION_MODES = {
  DEFERRED: 'deferred',
  IMMEDIATE: 'immediate',
  EXCLUSIVE: 'exclusive',
} as const;

export type SqliteJournalMode = (typeof SQLITE_JOURNAL_MODES)[keyof typeof SQLITE_JOURNAL_MODES];
export type SqliteTransactionMode = (typeof SQLITE_TRANSACTION_MODES)[keyof typeof SQLITE_TRANSACTION_MODES];
export type SqliteBackupOptions = BackupOptions;

export interface SqliteDatabaseOptions {
  readonly path: PathLike;
  readonly readOnly?: boolean;
  readonly readBigInts?: boolean;
  readonly busyTimeoutMs?: number;
  readonly statementCacheSize?: number;
  readonly journalMode?: SqliteJournalMode;
}

type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_CACHE_SIZE = 100;
const MAX_BUSY_TIMEOUT_MS = 2_147_483_647;
const MAX_STATEMENT_CACHE_SIZE = 1_000_000;

export class SqliteDatabase implements Disposable {
  public readonly connection: DatabaseSync;
  public readonly options: Readonly<SqliteDatabaseOptions>;
  public readonly sql: SQLTagStore;

  public constructor(options: SqliteDatabaseOptions) {
    validateOptions(options);

    this.options = Object.freeze({ ...options });
    this.connection = new DatabaseSync(options.path, {
      allowExtension: false,
      allowUnknownNamedParameters: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readBigInts: options.readBigInts ?? false,
      readOnly: options.readOnly ?? false,
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });

    if (options.journalMode !== undefined && options.readOnly !== true) {
      this.connection.exec(`PRAGMA journal_mode = ${options.journalMode.toUpperCase()}`);
    }

    this.sql = this.connection.createTagStore(options.statementCacheSize ?? DEFAULT_STATEMENT_CACHE_SIZE);
  }

  public get isOpen(): boolean {
    return this.connection.isOpen;
  }

  public exec(source: string): void {
    this.connection.exec(source);
  }

  public transaction<T>(operation: (database: this) => SynchronousResult<T>, mode: SqliteTransactionMode = SQLITE_TRANSACTION_MODES.IMMEDIATE): T {
    if (this.connection.isTransaction) throw new Error('Nested SQLite transactions are not supported');
    if (!Object.values(SQLITE_TRANSACTION_MODES).includes(mode)) throw new TypeError(`Unsupported SQLite transaction mode "${mode}"`);

    this.connection.exec(`BEGIN ${mode.toUpperCase()}`);

    try {
      const result = operation(this);
      if (isPromiseLike(result)) throw new TypeError('SQLite transaction callbacks must be synchronous');

      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        if (this.connection.isTransaction) this.connection.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'SQLite transaction and rollback both failed');
      }

      throw error;
    }
  }

  public backup(path: PathLike, options?: SqliteBackupOptions): Promise<number> {
    return options === undefined ? backupDatabase(this.connection, path) : backupDatabase(this.connection, path, options);
  }

  public close(): void {
    if (!this.connection.isOpen) return;
    this.sql.clear();
    this.connection.close();
  }

  public [Symbol.dispose](): void {
    this.close();
  }
}

export function createSqliteDatabase(options: SqliteDatabaseOptions): SqliteDatabase {
  return new SqliteDatabase(options);
}

function validateOptions(options: SqliteDatabaseOptions): void {
  if (options === null || typeof options !== 'object') throw new TypeError('SQLite options must be an object');
  if (!isPathLike(options.path)) throw new TypeError('SQLite path must be a non-empty string, Buffer, or file URL');
  if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean');
  if (options.readBigInts !== undefined && typeof options.readBigInts !== 'boolean') throw new TypeError('readBigInts must be a boolean');
  if (options.busyTimeoutMs !== undefined) assertIntegerInRange('busyTimeoutMs', options.busyTimeoutMs, 0, MAX_BUSY_TIMEOUT_MS);
  if (options.statementCacheSize !== undefined) assertIntegerInRange('statementCacheSize', options.statementCacheSize, 1, MAX_STATEMENT_CACHE_SIZE);

  if (options.journalMode !== undefined && !Object.values(SQLITE_JOURNAL_MODES).includes(options.journalMode)) {
    throw new TypeError(`Unsupported SQLite journal mode "${options.journalMode}"`);
  }
}
