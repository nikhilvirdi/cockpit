import * as fs from 'fs';
import * as path from 'path';
import { languageOf, EXCLUDED_DIRECTORIES } from './sourceKinds';
export { EXCLUDED_DIRECTORIES } from './sourceKinds';

export const SUPPORTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts'
]);

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function isSourceFile(fileName: string): boolean {
  return languageOf(fileName) !== undefined;
}

export function walkDirectory(dirPath: string, include = isSourceFile): string[] {
  const results: string[] = [];
  const normalizedDir = path.resolve(dirPath);

  if (!fs.existsSync(normalizedDir)) {
    return results;
  }

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
          if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) &&
            !(entry.name === 'vendor' && (fs.existsSync(path.join(currentDir, 'go.mod'))
              || fs.existsSync(path.join(fullPath, 'modules.txt'))))) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (include(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(normalizedDir);
  return results;
}
