/**
 * MongoDB (Atlas): where finished runs, coach debriefs and the coach's
 * research vectors live. Optional: without MONGODB_URI everything here is off
 * and the game plays exactly as before.
 *
 * Live play never touches MongoDB: each session's state stays in its Durable
 * Object (worker/session.ts). MongoDB only gets what is useful after a part
 * ends, written in the background so a slow or missing database can never
 * hold up the game.
 *
 * Workers cannot reuse a socket opened by another request, so each request
 * opens its own client and closes it when done (withDb).
 */
import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

export interface MongoEnv {
  /** mongodb+srv://… connection string (Atlas). */
  MONGODB_URI?: string;
  /** Database name. Default "oneinthree". */
  MONGODB_DB?: string;
}

export const mongoOn = (env: MongoEnv): boolean => Boolean(env.MONGODB_URI);

/** Run fn with a connected database, then close the client. Returns null if MongoDB is off or fails. */
export async function withDb<T>(env: MongoEnv, fn: (db: Db) => Promise<T>, label = 'mongo'): Promise<T | null> {
  if (!env.MONGODB_URI) return null;
  const client = new MongoClient(env.MONGODB_URI, {
    // Small and quick: one request's worth of work, and give up fast if Atlas is unreachable.
    maxPoolSize: 1,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 15000,
    appName: 'oneinthree-worker',
    // Cast: with the Workers types loaded, the driver's TLS option types read as all-required.
  } as Partial<MongoClientOptions> as MongoClientOptions);
  try {
    await client.connect();
    return await fn(client.db(env.MONGODB_DB || 'oneinthree'));
  } catch (err) {
    console.warn(`[${label}] MongoDB failed`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Round trip to the database: true if a ping succeeds. */
export async function pingMongo(env: MongoEnv): Promise<boolean> {
  const r = await withDb(env, async (db) => (await db.command({ ping: 1 })).ok === 1, 'mongo:ping');
  return r === true;
}
