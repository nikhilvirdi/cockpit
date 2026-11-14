import type { Language } from './types';

const languages: Record<string, Language> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', go: 'go', java: 'java', c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp'
};

export function languageOf(name: string): Language | undefined {
  const lower = name.toLowerCase();
  if (/\.d\.(ts|mts|cts)$/.test(lower)) return undefined;
  const dot = lower.lastIndexOf('.');
  const extension = lower.slice(dot + 1);
  return dot >= 0 && Object.hasOwn(languages, extension) ? languages[extension] : undefined;
}

export const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', '__pycache__', '.venv',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gradle', 'target', 'cmakefiles'
]);

const metadata = new Set([
  'package.json', 'pyproject.toml', 'pyrightconfig.json', 'setup.cfg', 'requirements.txt', 'setup.py',
  'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties',
  'cmakelists.txt', 'compile_commands.json', 'index.scip',
  'scip-python.scip', 'scip-go.scip', 'scip-java.scip', 'scip-clang.scip'
]);

export function isAnalysisInput(name: string): boolean {
  const lower = name.toLowerCase();
  return !!languageOf(lower) || metadata.has(lower) || /^(tsconfig|jsconfig).*\.json$/.test(lower);
}

