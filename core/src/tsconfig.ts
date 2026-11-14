import * as fs from 'fs';
import * as path from 'path';
import { ts } from 'ts-morph';
import { toPosixPath } from './scanner';

export interface TsConfigInfo {
  configPath?: string;
  baseUrl?: string;
  paths?: Record<string, string[]>;
  compilerOptions: ts.CompilerOptions;
  diagnostics?: readonly ts.Diagnostic[];
}

function parseConfigFile(configPath: string) {
  const filename = toPosixPath(configPath);
  const configFile = ts.readConfigFile(filename, ts.sys.readFile);
  if (configFile.error) {
    return { options: {}, references: undefined, diagnostics: [configFile.error] };
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    filename
  );
  return {
    options: parsed.options,
    references: parsed.projectReferences,
    // Cockpit discovers source files independently of the config's include/exclude lists.
    diagnostics: parsed.errors.filter(error => error.code !== 18002 && error.code !== 18003)
  };
}

// A root analysis clears these caches so separate snapshots can change configuration.
const tsconfigCache = new Map<string, TsConfigInfo>();
const configFileCache = new Map<string, TsConfigInfo>();

const configNames = ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];

function readConfig(configPath: string): TsConfigInfo {
  const cached = configFileCache.get(configPath);
  if (cached) return cached;

  const parsed = parseConfigFile(configPath);
  const diagnostics = [...parsed.diagnostics];
  const compilerOptions = { ...parsed.options };
  let { baseUrl, paths } = compilerOptions;

  // Keep the existing workspace fallback for aliases referenced by a solution config.
  for (const ref of parsed.references ?? []) {
    const refPath = path.resolve(path.dirname(configPath), ref.path);
    const filename = fs.statSync(refPath, { throwIfNoEntry: false })?.isDirectory()
      ? path.join(refPath, 'tsconfig.json') : refPath;
    const referenced = parseConfigFile(filename);
    diagnostics.push(...referenced.diagnostics);
    baseUrl ??= referenced.options.baseUrl;
    if (referenced.options.paths) paths = { ...paths, ...referenced.options.paths };
  }

  const result = { configPath, baseUrl, paths, compilerOptions, diagnostics };
  configFileCache.set(configPath, result);
  return result;
}

/**
 * Find the nearest tsconfig.json or jsconfig.json by walking up from the given directory.
 * Respects extends chains and merges configurations.
 */
export function findNearestTsConfig(startDir: string, rootDir: string): TsConfigInfo {
  // Normalize paths
  const normalizedStart = path.resolve(startDir);
  const normalizedRoot = path.resolve(rootDir);

  // Check cache first
  const cacheKey = JSON.stringify([normalizedRoot, normalizedStart]);
  const cached = tsconfigCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let currentDir = normalizedStart;
  let foundConfigPath: string | undefined;

  // Walk up from startDir to rootDir looking for tsconfig/jsconfig
  for (;;) {
    const relative = path.relative(normalizedRoot, currentDir);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) break;
    foundConfigPath = configNames.map(name => path.join(currentDir, name)).find(candidate => fs.existsSync(candidate));
    if (foundConfigPath || currentDir === normalizedRoot) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  const result = foundConfigPath ? readConfig(foundConfigPath) : { compilerOptions: {} };

  // Cache the result
  tsconfigCache.set(cacheKey, result);

  return result;
}

/**
 * Load tsconfig for a specific file, finding the nearest config in the directory hierarchy.
 * This is the new primary API for per-file resolution.
 */
export function loadTsConfigForFile(filePath: string, rootDir: string): TsConfigInfo {
  const fileDir = path.dirname(path.resolve(filePath));
  return findNearestTsConfig(fileDir, rootDir);
}

/**
 * Load tsconfig for the entire project (root-level).
 * Kept for backward compatibility and global config needs.
 */
export function loadTsConfig(targetDir: string, explicitConfigPath?: string): TsConfigInfo {
  tsconfigCache.clear();
  configFileCache.clear();

  if (explicitConfigPath) return readConfig(path.resolve(explicitConfigPath));

  const diagnostics: ts.Diagnostic[] = [];
  const result: TsConfigInfo = { compilerOptions: {}, diagnostics };
  for (const name of configNames) {
    const candidate = path.join(targetDir, name);
    if (!fs.existsSync(candidate)) continue;
    const config = readConfig(candidate);
    result.configPath ??= candidate;
    result.baseUrl ??= config.baseUrl;
    Object.assign(result.compilerOptions, config.compilerOptions);
    diagnostics.push(...(config.diagnostics ?? []));
    if (config.paths && Object.keys(config.paths).length > 0) {
      result.paths = config.paths;
      break;
    }
  }
  return result;
}
