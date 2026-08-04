import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  stage TEXT NOT NULL,
  source TEXT NOT NULL,
  pid INTEGER,
  product_id TEXT,
  promotion_id TEXT,
  share_url TEXT,
  title TEXT,
  product_name TEXT,
  shop_name TEXT,
  min_price TEXT,
  max_price TEXT,
  price TEXT,
  sales TEXT,
  url TEXT,
  class_name TEXT,
  method TEXT,
  value TEXT,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_product_id ON events(product_id);
CREATE INDEX IF NOT EXISTS idx_events_share_url ON events(share_url);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  shop_name TEXT NOT NULL DEFAULT '',
  min_price TEXT NOT NULL DEFAULT '',
  max_price TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  sales TEXT NOT NULL DEFAULT '',
  detail_url TEXT NOT NULL DEFAULT '',
  first_seen_ts INTEGER NOT NULL,
  last_seen_ts INTEGER NOT NULL,
  source_event_id TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  share_url TEXT PRIMARY KEY,
  product_id TEXT NOT NULL DEFAULT '',
  promotion_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  first_seen_ts INTEGER NOT NULL,
  last_seen_ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  source_event_id TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_product_id ON shares(product_id);

CREATE TABLE IF NOT EXISTS product_shares (
  product_id TEXT NOT NULL,
  share_url TEXT NOT NULL,
  first_seen_ts INTEGER NOT NULL,
  last_seen_ts INTEGER NOT NULL,
  confidence REAL NOT NULL,
  correlation_reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (product_id, share_url)
);

CREATE INDEX IF NOT EXISTS idx_product_shares_share_url ON product_shares(share_url);
`;

function field(event, name) {
  const value = event?.[name];
  return value === null || value === undefined ? '' : String(value);
}

function safeJson(value) {
  const seen = new WeakSet();
  try {
    const result = JSON.stringify(value, (_key, candidate) => {
      if (typeof candidate === 'bigint') return String(candidate);
      if (!candidate || typeof candidate !== 'object') return candidate;
      if (seen.has(candidate)) return '[Circular]';
      seen.add(candidate);
      return candidate;
    });
    return result === undefined ? 'null' : result;
  } catch (error) {
    return JSON.stringify({
      serialization_error: String(error?.message || error),
      value: String(value),
    });
  }
}

function isRetryableSqliteError(error) {
  return /busy|locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(error?.message || error));
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export class SQLiteEventStore {
  constructor({ dbPath, runId }) {
    if (!dbPath) throw new Error('dbPath is required');
    const inMemory = dbPath === ':memory:';
    this.dbPath = inMemory ? ':memory:' : path.resolve(dbPath);
    this.runId = runId || '';
    this.failurePath = inMemory ? '' : `${this.dbPath}.failed.jsonl`;
    this.writeCount = 0;
    this.writeFailures = 0;
    if (!inMemory) fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SCHEMA);
    this.db.exec('PRAGMA busy_timeout = 5000');
    ensureColumn(this.db, 'events', 'min_price', 'TEXT');
    ensureColumn(this.db, 'events', 'max_price', 'TEXT');
    ensureColumn(this.db, 'events', 'product_name', 'TEXT');
    ensureColumn(this.db, 'products', 'min_price', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'products', 'max_price', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'products', 'product_name', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'shares', 'product_name', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'shares', 'source', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'product_shares', 'source', "TEXT NOT NULL DEFAULT ''");

    this.insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, run_id, ts, event, stage, source, pid, product_id,
        promotion_id, share_url, title, product_name, shop_name, min_price, max_price, price, sales, url,
        class_name, method, value, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertProduct = this.db.prepare(`
      INSERT INTO products (
        product_id, promotion_id, title, product_name, shop_name, min_price, max_price, price, sales,
        detail_url, first_seen_ts, last_seen_ts, source_event_id, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        promotion_id = CASE WHEN excluded.promotion_id <> '' THEN excluded.promotion_id ELSE products.promotion_id END,
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE products.title END,
        product_name = CASE WHEN excluded.product_name <> '' THEN excluded.product_name ELSE products.product_name END,
        shop_name = CASE WHEN excluded.shop_name <> '' THEN excluded.shop_name ELSE products.shop_name END,
        min_price = CASE WHEN excluded.min_price <> '' THEN excluded.min_price ELSE products.min_price END,
        max_price = CASE WHEN excluded.max_price <> '' THEN excluded.max_price ELSE products.max_price END,
        price = CASE WHEN excluded.price <> '' THEN excluded.price ELSE products.price END,
        sales = CASE WHEN excluded.sales <> '' THEN excluded.sales ELSE products.sales END,
        detail_url = CASE WHEN excluded.detail_url <> '' THEN excluded.detail_url ELSE products.detail_url END,
        last_seen_ts = excluded.last_seen_ts,
        source_event_id = excluded.source_event_id,
        raw_json = excluded.raw_json
    `);
    this.upsertShare = this.db.prepare(`
      INSERT INTO shares (
        share_url, product_id, promotion_id, title, product_name, first_seen_ts, last_seen_ts,
        source, source_event_id, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(share_url) DO UPDATE SET
        product_id = CASE WHEN excluded.product_id <> '' THEN excluded.product_id ELSE shares.product_id END,
        promotion_id = CASE WHEN excluded.promotion_id <> '' THEN excluded.promotion_id ELSE shares.promotion_id END,
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE shares.title END,
        product_name = CASE WHEN excluded.product_name <> '' THEN excluded.product_name ELSE shares.product_name END,
        last_seen_ts = excluded.last_seen_ts,
        source = CASE WHEN excluded.source <> '' THEN excluded.source ELSE shares.source END,
        source_event_id = excluded.source_event_id,
        raw_json = excluded.raw_json
    `);
    this.upsertLink = this.db.prepare(`
      INSERT INTO product_shares (
        product_id, share_url, first_seen_ts, last_seen_ts, confidence,
        correlation_reason, source, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id, share_url) DO UPDATE SET
        last_seen_ts = excluded.last_seen_ts,
        confidence = MAX(product_shares.confidence, excluded.confidence),
        correlation_reason = excluded.correlation_reason,
        source = CASE WHEN excluded.source <> '' THEN excluded.source ELSE product_shares.source END,
        source_event_id = excluded.source_event_id
    `);
  }

  record(event) {
    if (!event?.event_id || !event.event) return false;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this._recordOnce(event);
        this.writeCount += 1;
        return true;
      } catch (error) {
        lastError = error;
        if (!isRetryableSqliteError(error) || attempt === 1) break;
      }
    }
    this.writeFailures += 1;
    this.recordFailure(event, lastError);
    return false;
  }

  recordFailure(event, error) {
    if (!this.failurePath) return;
    try {
      fs.appendFileSync(
        this.failurePath,
        `${safeJson({
          ts: Date.now(),
          error: String(error?.stack || error || 'unknown SQLite write failure'),
          event,
        })}\n`,
        'utf8',
      );
    } catch (_) {
      // A failed-event sidecar is best-effort and must not stop collection.
    }
  }

  _recordOnce(event) {
    if (!event?.event_id || !event.event) return;
    const rawJson = safeJson(event.raw ?? event);
    const ts = Number(event.ts) || Date.now();
    this.db.exec('BEGIN');
    try {
      this.insertEvent.run(
        field(event, 'event_id'),
        field(event, 'run_id') || this.runId,
        ts,
        field(event, 'event'),
        field(event, 'stage'),
        field(event, 'source'),
        event.pid === '' || event.pid === undefined ? null : Number(event.pid),
        field(event, 'product_id'),
        field(event, 'promotion_id'),
        field(event, 'share_url'),
        field(event, 'title'),
        field(event, 'product_name'),
        field(event, 'shop_name'),
        field(event, 'min_price'),
        field(event, 'max_price'),
        field(event, 'price'),
        field(event, 'sales'),
        field(event, 'url'),
        field(event, 'class'),
        field(event, 'method'),
        field(event, 'value'),
        rawJson,
      );

      if (event.event === 'product_found' && event.product_id) {
        this.upsertProduct.run(
          field(event, 'product_id'),
          field(event, 'promotion_id'),
          field(event, 'title'),
          field(event, 'product_name'),
          field(event, 'shop_name'),
          field(event, 'min_price'),
          field(event, 'max_price'),
          field(event, 'price'),
          field(event, 'sales'),
          field(event, 'url'),
          ts,
          ts,
          field(event, 'event_id'),
          rawJson,
        );
      }

      if (event.event === 'share_found' && event.share_url) {
        this.upsertShare.run(
          field(event, 'share_url'),
          field(event, 'product_id'),
          field(event, 'promotion_id'),
          field(event, 'title'),
          field(event, 'product_name'),
          ts,
          ts,
          field(event, 'source'),
          field(event, 'event_id'),
          rawJson,
        );
      }

      if (event.event === 'product_share_linked' && event.product_id && event.share_url) {
        this.upsertLink.run(
          field(event, 'product_id'),
          field(event, 'share_url'),
          ts,
          ts,
          Number(event.confidence) || 0,
          field(event, 'correlation_reason'),
          field(event, 'source'),
          field(event, 'event_id'),
        );
        this.upsertProduct.run(
          field(event, 'product_id'),
          field(event, 'promotion_id'),
          field(event, 'title'),
          field(event, 'product_name'),
          field(event, 'shop_name'),
          field(event, 'min_price'),
          field(event, 'max_price'),
          field(event, 'price'),
          field(event, 'sales'),
          field(event, 'url'),
          ts,
          ts,
          field(event, 'event_id'),
          rawJson,
        );
        this.upsertShare.run(
          field(event, 'share_url'),
          field(event, 'product_id'),
          field(event, 'promotion_id'),
          field(event, 'title'),
          field(event, 'product_name'),
          ts,
          ts,
          field(event, 'source'),
          field(event, 'event_id'),
          rawJson,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Fill only empty product fields from offline parser candidates.
   * Existing non-empty values, links, events and raw_json are untouched.
   */
  backfillProducts(records = []) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    const update = this.db.prepare(`
      UPDATE products SET
        product_name = CASE WHEN trim(product_name) = '' THEN COALESCE(NULLIF(trim(?), ''), product_name) ELSE product_name END,
        shop_name = CASE WHEN trim(shop_name) = '' THEN COALESCE(NULLIF(trim(?), ''), shop_name) ELSE shop_name END,
        price = CASE WHEN trim(price) = '' THEN COALESCE(NULLIF(trim(?), ''), price) ELSE price END,
        sales = CASE WHEN trim(sales) = '' THEN COALESCE(NULLIF(trim(?), ''), sales) ELSE sales END
      WHERE product_id = ?
    `);

    const result = {
      requested: records.length,
      matched: 0,
      updated: 0,
      skipped: 0,
      missing_products: 0,
      updated_products: [],
      fields_updated: {
        product_name: 0,
        shop_name: 0,
        price: 0,
        sales: 0,
      },
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const candidate of records) {
        const productId = field(candidate, 'product_id').trim();
        if (!productId) {
          result.skipped += 1;
          continue;
        }
        const before = this.db.prepare(`
          SELECT product_name, shop_name, price, sales
          FROM products WHERE product_id = ?
        `).get(productId);
        if (!before) {
          result.missing_products += 1;
          continue;
        }
        result.matched += 1;

        const values = {
          product_name: field(candidate, 'product_name'),
          shop_name: field(candidate, 'shop_name'),
          price: field(candidate, 'price'),
          sales: field(candidate, 'sales'),
        };
        const changedFields = Object.keys(values).filter((name) => (
          !String(before[name] || '').trim() && String(values[name] || '').trim()
        ));
        if (!changedFields.length) {
          result.skipped += 1;
          continue;
        }

        update.run(
          values.product_name,
          values.shop_name,
          values.price,
          values.sales,
          productId,
        );
        result.updated += 1;
        result.updated_products.push({
          product_id: productId,
          fields: Object.fromEntries(changedFields.map((name) => [name, values[name]])),
        });
        for (const name of changedFields) result.fields_updated[name] += 1;
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  close() {
    if (!this.db) return;
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    this.db.close();
    this.db = null;
  }

  stats() {
    return {
      writes: this.writeCount,
      write_failures: this.writeFailures,
      failure_path: this.failurePath,
    };
  }
}
