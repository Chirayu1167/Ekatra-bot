import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/db/migrations';

/**
 * Legacy SQLite helpers. node:sqlite lives ONLY in the import script (`src/scripts/import-sqlite.ts`)
 * plus this fixture builder, which constructs genuine Phase-2 SQLite databases (v1..v7 chain,
 * never edited) for the import path and its tests.
 */

export function buildSqliteV7(): DatabaseSync {
  return buildSqliteAt(':memory:', MIGRATIONS.length);
}

/** A v7 SQLite database at a file path (created with parent folders). For import fixtures. */
export function buildSqliteV7File(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  return buildSqliteAt(file, MIGRATIONS.length);
}

function buildSqliteAt(file: string, throughVersion: number): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  MIGRATIONS.slice(0, throughVersion).forEach((sql, index) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
  return db;
}

/** A genuine Phase 1 database (migrations 1..5 only), for upgrade-path tests. */
export function buildSqliteV5(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  MIGRATIONS.slice(0, 5).forEach((sql, index) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
  return db;
}

export function sqliteUserVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version;
}

/** Apply migration SQL strings the legacy way (transaction + user_version bump each). */
export function applySqliteMigrations(db: DatabaseSync, sqls: readonly string[]): void {
  const base = sqliteUserVersion(db);
  sqls.forEach((sql, index) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${base + index + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors on an already-broken connection.
      }
      throw err;
    }
  });
}
