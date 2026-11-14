import * as path from 'path';
import { Project, SyntaxKind, Node, ts } from 'ts-morph';
import { DependencyGraph, GraphEdge, GraphNode, GraphEngineOptions } from './types';
import { walkDirectory, toPosixPath, SUPPORTED_EXTENSIONS, isSourceFile } from './scanner';
import { loadTsConfig, loadTsConfigForFile, TsConfigInfo } from './tsconfig';
import { resolveImportTarget } from './resolver';

const graphProjects = new WeakMap<DependencyGraph, {
  project: Project;
  rootDir: string;
  diagnostics: Set<ts.Diagnostic>;
  fileConfigs: Map<string, TsConfigInfo>;
}>();

export function getGraphProject(graph: DependencyGraph) {
  return graphProjects.get(graph);
}

export function createAnalysisProject(rootDir: string, files: string[], explicitConfig?: string) {
  const projectFilesSet = new Set(files.map(file => path.resolve(file)));
  const rootConfig = loadTsConfig(rootDir, explicitConfig);
  const diagnostics = new Set(rootConfig.diagnostics);
  const fileConfigs = new Map<string, TsConfigInfo>();
  for (const file of projectFilesSet) {
    const config = explicitConfig ? rootConfig : loadTsConfigForFile(file, rootDir);
    fileConfigs.set(file, config);
    for (const diagnostic of config.diagnostics ?? []) diagnostics.add(diagnostic);
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, ...rootConfig.compilerOptions, allowJs: true, noEmit: true },
    resolutionHost: host => ({
      resolveModuleNames: (names, importer, _reused, redirected, options, sourceFile) => {
        const config = fileConfigs.get(path.resolve(importer));
        const localOptions = { ...options, ...config?.compilerOptions };
        const modes = new Map<string, Set<ts.ResolutionMode>>();
        for (const statement of sourceFile?.statements ?? []) {
          const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
            ? statement.moduleSpecifier
            : ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
              ? statement.moduleReference.expression : undefined;
          if (specifier && ts.isStringLiteral(specifier)) {
            const specifierModes = modes.get(specifier.text) ?? new Set<ts.ResolutionMode>();
            specifierModes.add(ts.getModeForUsageLocation(sourceFile!, specifier, localOptions));
            modes.set(specifier.text, specifierModes);
          }
        }
        return names.map(specifier => {
          // ts-morph 25 exposes name-based hooks, so mixed resolution modes resolve only if they agree.
          const specifierModes = modes.get(specifier) ?? [undefined];
          const resolutions = [...specifierModes].map(mode =>
            ts.resolveModuleName(specifier, importer, localOptions, host, undefined, redirected, mode).resolvedModule);
          const [resolved] = resolutions;
          if (resolutions.some(result => result?.resolvedFileName !== resolved?.resolvedFileName)) return undefined;
          if (resolved || !config) return resolved;
          // The existing file resolver covers workspace aliases and extension mappings.
          const target = resolveImportTarget({
            rootDir, fromFilePath: importer, specifier, tsConfigInfo: config, projectFilesSet
          });
          return target ? { resolvedFileName: toPosixPath(target) } : undefined;
        });
      }
    })
  });

  for (const file of projectFilesSet) project.addSourceFileAtPathIfExists(file);
  return { project, rootDir, diagnostics, projectFilesSet, fileConfigs };
}

/**
 * Builds a dependency graph for a TypeScript/JavaScript project folder.
 * 
 * @param targetPath Absolute or relative path to the project directory
 * @param options Optional configuration (e.g. custom tsconfig path)
 * @returns DependencyGraph containing nodes and edges
 */
export function buildDependencyGraph(targetPath: string, options?: GraphEngineOptions): DependencyGraph {
  const rootDir = path.resolve(targetPath);

  // Discover source files and retain the project for semantic analysis of the same snapshot.
  const scannedFiles = walkDirectory(rootDir, name => isSourceFile(name) &&
    SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()));
  const context = createAnalysisProject(rootDir, scannedFiles, options?.tsConfigPath);
  const { project, projectFilesSet, fileConfigs } = context;

  // Construct nodes
  const nodes: GraphNode[] = scannedFiles.map(filePath => {
    const relPath = path.relative(rootDir, filePath);
    return {
      id: toPosixPath(relPath),
      path: toPosixPath(path.resolve(filePath))
    };
  });

  // Sort nodes alphabetically by id for deterministic output
  nodes.sort((a, b) => a.id.localeCompare(b.id));

  // Extract imports and requires, resolve targets to build edges
  const edges: GraphEdge[] = [];
  const edgeKeySet = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    const fromFilePath = path.resolve(sourceFile.getFilePath());
    const fromRelative = toPosixPath(path.relative(rootDir, fromFilePath));
    const rawSpecifiers: string[] = [];

    // Static imports: import ... from '...' and import '...'
    for (const importDecl of sourceFile.getImportDeclarations()) {
      const specifier = importDecl.getModuleSpecifierValue();
      if (specifier) {
        rawSpecifiers.push(specifier);
      }
    }

    // Re-exports with module specifiers: export ... from '...'
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const specifier = exportDecl.getModuleSpecifierValue();
      if (specifier) {
        rawSpecifiers.push(specifier);
      }
    }

    // TypeScript import equals: import x = require('...')
    for (const importEquals of sourceFile.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
      const moduleRef = importEquals.getModuleReference();
      if (Node.isExternalModuleReference(moduleRef)) {
        const expr = moduleRef.getExpression();
        if (expr) {
          const rawText = expr.getText();
          const clean = rawText.replace(/^['"`]|['"`]$/g, '').trim();
          if (clean) {
            rawSpecifiers.push(clean);
          }
        }
      }
    }

    // Call expressions: require('...') and dynamic import(...) check
    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = callExpr.getExpression();

      // Dynamic import(): import('...')
      // TODO: Dynamic import() support can be added in a future phase.
      if (expr.getKind() === SyntaxKind.ImportKeyword || expr.getText() === 'import') {
        // Flagged as TODO, skip for v1 without failing
        continue;
      }

      // CommonJS require('...')
      if (expr.getText() === 'require') {
        const args = callExpr.getArguments();
        if (args.length > 0) {
          const firstArg = args[0];
          if (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg)) {
            const val = firstArg.getLiteralValue();
            if (val) {
              rawSpecifiers.push(val);
            }
          }
        }
      }
    }

    // Resolve each specifier to a project file
    for (const specifier of rawSpecifiers) {
      const resolvedTarget = resolveImportTarget({
        rootDir,
        fromFilePath,
        specifier,
        tsConfigInfo: fileConfigs.get(fromFilePath),
        projectFilesSet
      });

      if (resolvedTarget) {
        const toRelative = toPosixPath(path.relative(rootDir, resolvedTarget));

        // Skip self-references if any, and deduplicate edges
        const edgeKey = `${fromRelative}->${toRelative}`;
        if (!edgeKeySet.has(edgeKey)) {
          edgeKeySet.add(edgeKey);
          edges.push({
            from: fromRelative,
            to: toRelative
          });
        }
      }
    }
  }

  // Sort edges deterministically by from, then by to
  edges.sort((a, b) => {
    const fromDiff = a.from.localeCompare(b.from);
    if (fromDiff !== 0) return fromDiff;
    return a.to.localeCompare(b.to);
  });

  const graph: DependencyGraph = {
    nodes,
    edges
  };
  graphProjects.set(graph, context);

  return graph;
}
