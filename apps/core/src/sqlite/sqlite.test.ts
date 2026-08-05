import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { createSqliteDatabase, SQLITE_JOURNAL_MODES } from './sqlite.js';

describe('SQLite database', () => {
  it('executes cached tagged statements with bound values', () => {
    using database = createSqliteDatabase({ path: ':memory:' });
    database.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT');

    const name = "Project'); DROP TABLE projects; --";
    database.sql.run`INSERT INTO projects (name) VALUES (${name})`;

    const project = database.sql.get`SELECT id, name FROM projects WHERE name = ${name}`;
    assert.equal(project?.id, 1);
    assert.equal(project?.name, name);
    assert.equal(database.sql.size, 2);
  });

  it('commits successful transactions and rolls back failures', () => {
    using database = createSqliteDatabase({ path: ':memory:' });
    database.exec('CREATE TABLE values_table (value INTEGER NOT NULL) STRICT');

    const result = database.transaction((transaction) => {
      transaction.sql.run`INSERT INTO values_table (value) VALUES (${1})`;
      return 'committed';
    });
    assert.equal(result, 'committed');

    assert.throws(() =>
      database.transaction((transaction) => {
        transaction.sql.run`INSERT INTO values_table (value) VALUES (${2})`;
        throw new Error('rollback');
      }),
    );

    assert.deepEqual(
      database.sql.all`SELECT value FROM values_table ORDER BY value`.map((row) => row.value),
      [1],
    );
  });

  it('rejects asynchronous and nested transaction callbacks', () => {
    using database = createSqliteDatabase({ path: ':memory:' });
    const promise: unknown = Promise.resolve('later');

    assert.throws(() => database.transaction(() => promise), /must be synchronous/);
    assert.throws(
      () =>
        database.transaction((transaction) => {
          transaction.transaction(() => undefined);
        }),
      /Nested SQLite transactions/,
    );
    assert.equal(database.connection.isTransaction, false);
  });

  it('creates file backups and supports WAL mode', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'mvv-sqlite-'));
    const sourcePath = join(directory, 'source.db');
    const backupPath = join(directory, 'backup.db');
    context.after(async () => rm(directory, { recursive: true, force: true }));

    using database = createSqliteDatabase({ path: sourcePath, journalMode: SQLITE_JOURNAL_MODES.WAL });
    database.exec('CREATE TABLE state (value TEXT NOT NULL) STRICT; INSERT INTO state VALUES (\'ready\')');
    await database.backup(backupPath);

    using backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(backup.prepare('SELECT value FROM state').get()?.value, 'ready');
    assert.equal(database.connection.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  });

  it('closes idempotently and validates configuration eagerly', () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    database.close();
    database.close();
    assert.equal(database.isOpen, false);

    assert.throws(() => createSqliteDatabase({ path: '' }), /path must be/);
    assert.throws(() => createSqliteDatabase({ path: ':memory:', busyTimeoutMs: -1 }), /busyTimeoutMs/);
    assert.throws(() => createSqliteDatabase({ path: ':memory:', statementCacheSize: 0 }), /statementCacheSize/);
  });
});
