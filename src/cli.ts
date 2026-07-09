#!/usr/bin/env node
import { openDatabase } from "./db.js";
import { startServer } from "./app.js";
import { DEFAULT_PORT } from "./types.js";

function usage(): never {
  console.error(`Usage:
  local-issues serve [--port <n>] [--host <host>]

Environment:
  LOCAL_ISSUES_DATA_DIR   Directory for SQLite database (default: ./data)
  PORT                    Default port if --port not given`);
  process.exit(2);
}

function parseArgs(args: string[]): { port: number; host: string } {
  let port = Number(process.env.PORT ?? DEFAULT_PORT);
  let host = "127.0.0.1";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") {
      port = Number(args[++i]);
      if (!Number.isInteger(port) || port <= 0) {
        console.error("Invalid --port value");
        process.exit(2);
      }
    } else if (arg === "--host") {
      host = args[++i];
    } else {
      usage();
    }
  }

  return { port, host };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] !== "serve") usage();

  const { port, host } = parseArgs(args.slice(1));
  const db = openDatabase();
  startServer({ db, port, host });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
