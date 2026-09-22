import '../quiet.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Db = DatabaseSync;

/**
 * Opens (and creates on first use) the memory store. WAL keeps the viewer's reads
 * from blocking a hook's write while a session is being extracted.
 */
export function openDb(config: Pick<Config, 'dbPath'>): Db {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** A value SQLite can bind to a `?` placeholder. */
export type Param = string | number | bigint | null | Uint8Array;

/**
 * node:sqlite returns untyped rows. These two helpers put the cast in one place
 * instead of at every call site.
 */
export function queryAll<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function queryOne<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transact<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
