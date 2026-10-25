import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_KINDS = ['MESSAGE', 'STATE', 'GATE', 'REVIEW', 'HOOK', 'INGEST', 'ERROR'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface BusLog {
  readonly file: string;
  logLine(kind: LogKind, text: string): void;
}

/** `HH:MM:SS KIND         text` (kind padded to 12 columns), local time. */
export function formatLogLine(kind: LogKind, text: string, at: Date = new Date()): string {
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return `${time} ${kind.padEnd(12)} ${text.replace(/\r?\n/g, ' ')}`;
}

/** Appends human-readable lines to `<dataDir>/bus.log`; failures never break a tool call. */
export function createBusLog(dataDir: string): BusLog {
  const file = join(dataDir, 'bus.log');
  return {
    file,
    logLine(kind, text) {
      try {
        mkdirSync(dataDir, { recursive: true });
        appendFileSync(file, `${formatLogLine(kind, text)}\n`);
      } catch (error) {
        process.stderr.write(
          `dromos: cannot write ${file}: ${error instanceof Error ? error.message : error}\n`,
        );
      }
    },
  };
}
