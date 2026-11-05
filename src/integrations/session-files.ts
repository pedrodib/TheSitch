import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Lists session logs without following links or entering unrelated directories. */
export async function sessionFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 10)
    throw new Error('Profundidade máxima dos arquivos de sessão excedida; inventário incompleto.');
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (result.length >= 100_000) throw new Error('Session file limit exceeded');
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await sessionFiles(file, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(file);
  }
  return result;
}
