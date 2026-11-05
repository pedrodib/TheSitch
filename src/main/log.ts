import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Logs fixed operation identifiers, never CLI output, credentials or imported content. */
export function operationLog(
  dataDir: string,
  event: string,
  fields: { source?: string; outcome?: string } = {},
): void {
  try {
    const file = join(dataDir, 'operations.jsonl');
    if (existsSync(file) && statSync(file).size > 1_000_000) renameSync(file, `${file}.previous`);
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, {
      mode: 0o600,
    });
  } catch {
    // Logging must not prevent access to a healthy local database.
  }
}
