// One row per model call, in SQLite (Node's built-in node:sqlite, no native dependency).
// Recording never throws: a broken log must not break the request it describes.
import { DatabaseSync } from "node:sqlite";

export interface CallRecord {
  taskId: string | null;
  /** Free label for comparisons, e.g. "routed" vs "frontier". */
  arm: string | null;
  complexity: number | null;
  routed: boolean;
  routeReason: string | null;
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  /** null when the model has no price in the table. */
  costUsd: number | null;
  latencyMs: number;
  routerMs: number | null;
  ok: boolean;
  error: string | null;
}

export interface ModelSummary {
  model: string;
  calls: number;
  successRate: number;
  costUsd: number;
  unpricedCalls: number;
  avgLatencyMs: number;
}

export interface Telemetry {
  record(row: CallRecord): boolean;
  summary(sinceHours?: number): ModelSummary[];
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  task_id TEXT, arm TEXT, complexity INTEGER, routed INTEGER NOT NULL, route_reason TEXT,
  model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL, cost_usd REAL, latency_ms INTEGER NOT NULL,
  router_ms INTEGER, ok INTEGER NOT NULL, error TEXT
);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);`;

export interface TelemetryOptions {
  /** Called when a write fails. Default: a process warning, so failures are visible but never thrown. */
  onError?: (error: Error) => void;
}

const warn = (e: Error): void => process.emitWarning(`llm-tier-router telemetry write failed: ${e.message}`);

export function createTelemetry(path: string, { onError = warn }: TelemetryOptions = {}): Telemetry {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO calls (task_id, arm, complexity, routed, route_reason, model, prompt_tokens,
    cached_tokens, completion_tokens, cost_usd, latency_ms, router_ms, ok, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  return {
    record(r) {
      try {
        insert.run(r.taskId, r.arm, r.complexity, r.routed ? 1 : 0, r.routeReason, r.model, r.promptTokens, r.cachedTokens,
          r.completionTokens, r.costUsd, r.latencyMs, r.routerMs, r.ok ? 1 : 0, r.error);
        return true;
      } catch (e) {
        onError(e as Error);
        return false;
      }
    },
    summary(sinceHours = 24 * 365) {
      const rows = db.prepare(`SELECT model, COUNT(*) AS calls, AVG(ok) AS successRate, COALESCE(SUM(cost_usd),0) AS costUsd,
          SUM(cost_usd IS NULL) AS unpricedCalls, AVG(latency_ms) AS avgLatencyMs
        FROM calls WHERE ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) GROUP BY model ORDER BY costUsd DESC`)
        .all(`-${sinceHours} hours`) as unknown as ModelSummary[];
      return rows.map((r) => ({ ...r, calls: Number(r.calls), unpricedCalls: Number(r.unpricedCalls), avgLatencyMs: Math.round(r.avgLatencyMs) }));
    },
    close() {
      db.close();
    },
  };
}
