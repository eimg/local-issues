import type Database from "better-sqlite3";
import {
  DEFAULT_LABEL_FILTER,
  DEFAULT_COMMENT_TRIGGER,
  DEFAULT_WEBHOOK_URL,
  type AppConfig,
} from "./types.js";

const DEFAULTS: AppConfig = {
  webhookUrl: DEFAULT_WEBHOOK_URL,
  labelFilter: DEFAULT_LABEL_FILTER,
  commentTrigger: DEFAULT_COMMENT_TRIGGER,
  webhookEnabled: false,
  baseUrl: "http://127.0.0.1:8320",
  defaultRepositoryPath: "",
};

export function loadConfig(db: Database.Database): AppConfig {
  const rows = db.prepare("SELECT key, value FROM config").all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    webhookUrl: stored.webhookUrl ?? DEFAULTS.webhookUrl,
    labelFilter: stored.labelFilter ?? DEFAULTS.labelFilter,
    commentTrigger: stored.commentTrigger ?? DEFAULTS.commentTrigger,
    webhookEnabled: stored.webhookEnabled !== undefined ? stored.webhookEnabled === "true" : DEFAULTS.webhookEnabled,
    baseUrl: stored.baseUrl ?? DEFAULTS.baseUrl,
    defaultRepositoryPath: stored.defaultRepositoryPath ?? DEFAULTS.defaultRepositoryPath,
  };
}

export function saveConfig(db: Database.Database, patch: Partial<AppConfig>): AppConfig {
  const upsert = db.prepare(`
    INSERT INTO config (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const tx = db.transaction((updates: Partial<AppConfig>) => {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      upsert.run({
        key,
        value: typeof value === "boolean" ? String(value) : value,
      });
    }
  });

  tx(patch);
  return loadConfig(db);
}

export function setBaseUrl(db: Database.Database, baseUrl: string): void {
  saveConfig(db, { baseUrl });
}
