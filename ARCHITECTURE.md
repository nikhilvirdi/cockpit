## Cockpit

### What This Is

Cockpit is a focused, interactive dependency explorer for source code repositories. Its only job is to answer three related questions, with evidence that can actually be inspected: what depends on what, why that dependency exists, and where in the code it's expressed.

Give it a public GitHub repository URL or a local project folder. It outputs an interactive, source-backed graph of file and module dependencies, plus function-to-function calls. A high-level dependency should be traceable all the way down to the exact symbol and source location behind it, without reading an auto-generated codebase summary.

Cockpit is an analysis and navigation tool. It's not an architectural quality grader, a runtime tracer, an IDE, or an AI assistant. What matters most here is correctness, traceability, legibility, and keeping interaction cost low. A smaller graph that's upfront about its limits beats a complete-looking one full of guessed relationships.

This document describes where the product is meant to end up, not a claim that every piece already works. The current repository is the implementation baseline. Where it behaves differently from what's written here, this document wins.

### Scope

#### Supported Languages

The target language set is **JavaScript, TypeScript, Python, Go, Java, C, and C++**. JavaScript and TypeScript share most of their analysis infrastructure; C and C++ share Clang-based infrastructure. Supporting a language is a specific capability with its own coverage and prerequisites, not a blanket promise that every repository in that language gets fully analyzed.

Cockpit can analyze repositories that mix several supported languages. Each language gets indexed by its own resolution rules. Cross-language calls, through FFI, generated bindings, RPC, or reflection, don't get inferred just because names look similar across languages. Those relationships need real, semantically supported evidence. Otherwise they stay out of the resolved call graph.

HTML, CSS, and other unrelated assets aren't analysis targets. Build manifests and language configuration files can be read as resolution metadata without turning into graph features.

#### Required Capabilities

- **File/module dependency view.** Project source files and their statically established imports, includes, or module dependencies, including across folders. Each language's actual dependency unit gets respected instead of inventing edges between arbitrary files.
- **Function dependency view.** Calls between resolvable project-defined functions, methods, and constructors, whether they're in the same file, a different file, or a different directory. The graph expands out from a selected file or function rather than rendering every callable at once.
- **Evidence-backed inspection.** Selecting an edge surfaces the imported or referenced symbol, where it came from, the resolved target definition when there is one, and the exact source location. A reference never gets mislabeled as a call.
- **Focused exploration.** Search for files and functions, select, zoom and pan, highlight incoming and outgoing relationships, and expand the neighborhood incrementally. Selection stays reversible and easy to follow.
- **Circular file-dependency highlighting.** Directed cycles among resolved file-level dependency edges get found, and the components involved get highlighted. This is a visual aid, not a separate scoring system.

#### Explicit Non-Goals

Environment-variable tracing, orphan or dead-code detection, entry-point heuristics, fan-in/fan-out dashboards, architectural health scores, AI-generated explanations, automatic refactoring, runtime execution tracing, dependency vulnerability scanning, framework-specific application modeling, and multiple competing graph renderers are all out of scope.

Basic incoming/outgoing dependency counts can show up as incidental metadata in the inspector. They don't grow into a metrics dashboard. An external dependency can be named in the inspector when it explains an import, but rendering the full third-party dependency ecosystem isn't part of the default graph.

### Architectural Principles

#### Evidence Before Visualization

The graph is a derived view of static source evidence. Whatever analyzer produces it has to preserve the source location and resolution outcome of every import, reference, and call that matters. The visualization layer never resolves symbols on its own, never guesses an edge from a name, and never quietly turns a possible target into a confirmed one.

#### Keeping Syntax and Semantics Separate

An AST parser tells you what syntactic construct exists and what scope it sits in. A semantic analyzer or compiler index tells you which declaration a symbol actually refers to. Neither one by itself is a general-purpose call graph. Cockpit joins both kinds of evidence and validates the relationship before it ever becomes a call edge.

#### One Graph, Interpreted Per Language

Language adapters emit a normalized intermediate representation. The core graph builder and the React client don't contain any Python-, Go-, Java-, or C++-specific resolution logic. That logic lives in the adapters. The normalized model still has to carry enough language-specific context to avoid false equivalences; for example, a Go package import isn't an import of every `.go` file in that package.

#### Minimal Changes, Earned Replacements

Reusing what already works beats adding a replacement for its own sake. The npm workspace architecture, the Express ingestion routes, the `ts-morph` integration, and the Cytoscape renderer are all worth keeping. A new indexer earns its place only if it genuinely improves semantic coverage or lowers maintenance cost. Two analyzers don't run on the same language with their outputs merged indiscriminately; each output needs a clear authority and a deduplication rule.

### System Architecture

The architecture diagram is maintained separately and dropped in here. Whatever gets built has to follow this data flow:

**GitHub URL or local folder → validated, bounded workspace → source discovery and configuration detection → language adapters → semantic references and AST call sites → normalized dependency evidence → file and function graphs → interactive Cytoscape views and source inspector.**

There are three existing npm workspaces, each with a stable job. **`@cockpit/core`** owns analysis and the graph contracts. **`@cockpit/server`** owns ingestion, process orchestration, limits, and HTTP delivery. **`client`** owns graph presentation and interaction. These are logical boundaries, not an invitation to spin up more packages or services.

#### Core Analysis Boundary

The core takes in a validated workspace and analysis options, and returns a deterministic, serializable analysis result containing normalized nodes, edges, source evidence, language-level coverage information, and diagnostics. It knows nothing about HTTP, GitHub URL handling, browser state, UI layout, or uploads.

#### Server Boundary

The server acquires a workspace, invokes language tools under controlled resource limits, collects their output, calls the core's normalization and graph-building logic, and delivers the result. It's responsible for cleanup even when a clone, extraction, indexer, or request fails. Long-running analysis can't block the Express event loop.

#### Client Boundary

The client receives the completed graph and evidence. It derives visible subgraphs from selection and focus state instead of requesting a new static analysis on every click. It never treats its own rendering output as the source of truth. Graph state, selection state, and source evidence stay logically separate.

### Input Acquisition and Workspace Handling

#### Public GitHub Repository

GitHub input only accepts a validated public repository URL of the intended GitHub-hosted form. `simple-git` handles a shallow, bounded clone into a unique temporary workspace. Arbitrary Git URLs, local paths, command options, redirects to unsupported hosts, and credentials embedded in the URL all get rejected. Submodules and Git LFS content aren't fetched automatically; missing content shows up in the coverage diagnostics instead.

The analysis result records the repository URL and the resolved commit SHA, so source locations link to the exact revision that got analyzed, not a branch that keeps moving. Repository contents are treated as untrusted data. Cloning a repo is not permission to run its scripts.

#### Local Folder

The browser can use a directory picker or directory-upload capability to enumerate a user-selected folder. `JSZip` packages the selected files; `Multer` receives the upload. Browser APIs and permissions aren't consistent across browsers, so local selection has to degrade gracefully rather than assuming every browser exposes the same File System Access API.

Relative paths get preserved, irrelevant generated or dependency directories get excluded, and secrets that don't need to be there don't get uploaded. The client has to report any exclusion that materially changes the analysis. A local-folder upload is a snapshot, not a live filesystem mount or a continuous watcher.

In-memory, whole-archive extraction using **`adm-zip`** is being replaced with bounded, streaming extraction using **`yauzl`**, or something equivalent that allows iterating entries explicitly. A compressed-upload size limit alone isn't enough: expanded byte total, entry count, per-file size, depth, illegal paths, unexpected symlinks, and decompression behavior all get validated. Anything that escapes the workspace after path normalization gets rejected.

#### Workspace Lifetime

Every analysis gets its own isolated temporary workspace. Source copies, SCIP output, and parser artifacts are all scoped to that one analysis and get removed on completion, cancellation, timeout, or failure. The client still needs source inspection after cleanup, so the result has to retain bounded excerpts and line locations as evidence on its own. It can't depend on temporary files sticking around.

### Source Discovery and Configuration

Scan supported source extensions and exclude the usual suspects: generated content, version-control metadata, vendored dependency trees, caches, and binary files. Respect recognized source roots and project configuration where it exists. Don't follow symlinks outside the workspace. Keep a warning around whenever exclusion or missing generated sources make resolution incomplete.

Discovery is language-aware. Relevant configuration includes `tsconfig.json`/`jsconfig.json` and `package.json` for JS/TS, Python project/environment configuration, `go.mod`/`go.work` for Go, Maven/Gradle metadata for Java, and compilation databases such as `compile_commands.json` for C/C++. Configuration files are analysis inputs; their presence doesn't create an unrelated dashboard feature.

A file belongs to the graph by its normalized repository-relative path. Absolute temporary workspace paths never appear in graph IDs or API responses.

### Static Analysis Technologies

#### SCIP as the Common Semantic Interchange Format

SCIP, the Code Intelligence Protocol, is the interchange format for semantic symbol definitions and references coming out of existing compiler-aware indexers. Its Protobuf records give source occurrences, roles, symbol identifiers, and definition/reference relationships. They get decoded using the official TypeScript bindings, **`@scip-code/scip`** where it's available and compatible, or bindings generated from the official SCIP Protobuf schema. Tested schema and indexer versions get pinned rather than assuming every indexer gives identical coverage or source-position conventions.

SCIP is not the Cockpit graph model, and it's not a ready-made function-call graph. Reference occurrences still have to be matched to AST call expressions and the target declaration verified. SCIP symbol identities are useful internal semantic keys, but they don't replace repository-relative file identity or a stable, versioned Cockpit API contract.

#### Tree-sitter for Language-Neutral Syntax Extraction

Tree-sitter, through the Node.js **`tree-sitter`** bindings, handles syntax extraction with compatible, pinned language grammars: **`tree-sitter-python`**, **`tree-sitter-go`**, **`tree-sitter-java`**, **`tree-sitter-c`**, and **`tree-sitter-cpp`**. Its syntax trees and queries find import/include constructs, function and method boundaries, constructors, call expressions, and enclosing scopes. The specific grammar versions have to be tested against the native Node bindings before adoption.

Tree-sitter gives syntax, not type checking or project-aware symbol resolution. A syntactic call name alone is never enough for a verified cross-file edge. JavaScript/TypeScript keeps using `ts-morph` for both syntax and semantics; a second parser isn't needed there unless there's a concrete reason for one.

#### JavaScript and TypeScript

`ts-morph` and the underlying TypeScript compiler project model stay as the primary JS/TS implementation. It already supports project-aware import resolution and AST access. It resolves relative paths, `tsconfig` aliases, workspace boundaries, barrel re-exports, named/default/namespace imports, CommonJS `require`, and relevant type-only references, without conflating types with calls.

The existing `symbolUsage.ts` identifies imported references and their enclosing scopes. `functionGraph.ts` shares the same compiler project, classifies actual call expressions, and binds defensible targets to their declarations. Call edges group every site for a caller and callee. Overload evidence preserves the compiler-selected signature and the implementation location.

**`scip-typescript`** is a credible alternative semantic producer and a compatibility target for the common SCIP adapter. It needs validating against the existing `ts-morph` results before substituting it in for a working resolution path. Both shouldn't run as mandatory duplicate passes over every JS/TS repository.

#### Python

**`scip-python`** (Pyright-based) handles project-aware symbol references, together with the Tree-sitter Python grammar for syntactic call contexts and enclosing functions. Relative imports and package/module structure get resolved using the analyzer's environment-aware rules. Diagnostics stay around for missing interpreters, import paths, dependencies, or unresolved types.

Python's dynamic attributes, decorators, monkey patching, factory-returned callables, and dynamic imports put a hard ceiling on what's possible. A syntactically valid `obj.method()` call doesn't guarantee a unique runtime implementation. A missing Python environment lowers coverage, not an unapproved package install or a fabricated target.

#### Go

**`scip-go`** handles compiler-informed symbol references, and the Tree-sitter Go grammar covers call sites, declarations, and source ranges. Go module/workspace configuration and the package build context drive resolution. Package imports are first-class here: a Go import names a package, not one particular source file. Package-level relationships get modeled explicitly and expanded to actual definitions once a resolved symbol or call points at a file.

Build tags, generated files, methods, interfaces, and possible dynamic interface dispatch all get accounted for. The tool may invoke Go tooling to load packages; external package drivers and downloads need to be restricted by execution policy.

#### Java

**`scip-java`** handles semantic declarations and references, and the Tree-sitter Java grammar covers call-site classification and enclosing members. Getting target binding right depends on classes, packages, overload resolution, inherited members, and a usable compilation environment. Maven/Gradle configuration provides the necessary context, but just having a `pom.xml` doesn't guarantee successful indexing.

`scip-java` can trigger build-tool activity as part of compiling. Project build commands don't run automatically on untrusted uploads or public GitHub repositories on a shared server. When safe semantic indexing isn't available, a clearly marked partial analysis shows instead of claiming full function-call coverage. A trusted local deployment can explicitly enable a controlled build-capable executor, but under its own separate security policy.

#### C and C++

**`scip-clang`** handles compiler-aware semantic references, and the Tree-sitter C/C++ grammars cover include directives, declarations, and call sites at the source level. Accurate indexing normally needs **`compile_commands.json`** describing translation units, include paths, macros, compiler flags, and language modes. An existing CMake-generated compilation database can be consumed; Cockpit doesn't silently configure or build an unknown project just to produce one.

`#include` counts as a dependency on a header resource, not proof of a function call. Textual inclusion and semantic references stay distinct. Conditional compilation and macros mean results can be translation-unit-specific. Equivalent semantic declarations get merged carefully, but per-configuration evidence stays where it actually changes a relationship. Overloads, templates, namespaces, methods, virtual dispatch, and function pointers all get accounted for. If a compilation database or required generated headers are missing, the result comes back incomplete. A Tree-sitter include graph is a syntax-only fallback, not full semantic coverage.

### The Normalized Model

#### Graph Semantics

Cockpit keeps two user-facing graph projections built from one normalized evidence model:

- A **file/module graph**, where a directed edge `A → B` means A has a statically established dependency on B. For Go and other languages with package imports, the target might be a package node rather than an invented file target. C/C++ headers are valid file targets for include edges.
- A **function-call graph**, where a directed edge `caller → callee` means a qualifying call expression inside `caller` has been semantically tied to `callee`. Same-file calls and cross-file calls use the same representation. These edges represent static analysis, not observed runtime execution.

An import or symbol reference can support the file inspector without implying a function-call edge. A function call doesn't need a textual `import` in the caller's file either; same-file calls, class relationships, and resolvable globals are all examples.

#### Canonical Entities and Evidence

The wire format is meant to be small, typed, versioned, and extensible, without embedding parser-specific AST objects. The TypeScript interfaces below are illustrative contracts. Fields might shift once they get validated against real indexer output, but their meaning is fixed.

```ts
type Language =
  | 'javascript' | 'typescript' | 'python'
  | 'go' | 'java' | 'c' | 'cpp';

type Resolution = 'resolved' | 'ambiguous' | 'unresolved';
type DependencyKind = 'import' | 'include' | 'call';

type SourceRange = {
  file: string; // normalized repository-relative path
  startLine: number; // zero-based, inclusive
  startColumn: number;
  endLine: number; // zero-based, exclusive position
  endColumn: number;
};

type DependencyNode = {
  id: string;
  kind: 'file' | 'package' | 'function';
  language: Language;
  name: string;
  file?: string; // mandatory for a file or source-defined function
  range?: SourceRange; // declaration span when known
  semanticKey?: string; // SCIP/compiler identity when available
};

type DependencyEvidence = {
  kind: DependencyKind | 'symbol-reference';
  at: SourceRange; // exact import, include, reference, or call site
  sourceSymbol?: string; // enclosing caller or scope identity
  targetSymbol?: string; // resolved definition identity, if known
  importedName?: string; // imported spelling, where applicable
  resolvedName?: string; // canonical target spelling, if known
  typeOnly?: boolean;
  excerpt?: string; // bounded source excerpt for inspection
};

type DependencyEdge = {
  id: string;
  source: string; // consumer/caller node ID
  target: string; // supplier/callee node ID
  kind: DependencyKind;
  evidence: DependencyEvidence[];
};

type UnresolvedSite = {
  kind: DependencyKind | 'symbol-reference';
  at: SourceRange;
  reason: string;
  candidates?: string[]; // never presented as confirmed targets
};

type LanguageCoverage = {
  language: Language;
  status: 'complete' | 'partial' | 'unavailable';
  analyzer: string;
  diagnostics: string[];
};

type CockpitGraph = {
  schemaVersion: string;
  source: { kind: 'github' | 'upload'; commit?: string; url?: string };
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  unresolved: UnresolvedSite[];
  coverage: LanguageCoverage[];
};
```

"Complete" means the configured analysis ran without known coverage gaps for its declared scope. It does not mean static analysis found every possible runtime call. The absence of an edge is never proof that no runtime dependency exists.

#### Identity and Location Rules

File IDs come from normalized repository-relative paths. Callable IDs distinguish overloads, methods, and same-name declarations using a stable semantic key and, when needed, the declaration location. A human-readable function name by itself isn't an identifier. IDs have to be deterministic for a given source snapshot and analyzer configuration.

All ranges use one documented internal indexing convention. SCIP, Tree-sitter, TypeScript, and editor APIs don't all agree on character offset or byte conventions, so adapters have to normalize these correctly, Unicode and CRLF included. Users see one-based line numbers, while exact source paths stay separate from the shortened labels users actually see.

#### Unresolved and Ambiguous Relationships

Only resolved file targets and statically bound callable targets produce ordinary dependency edges. Ambiguous or unresolved call sites go into `unresolved` and can show up in the selected file's inspector with a reason attached. If a compiler gives a declared virtual or interface method but not a unique runtime implementation, that distinction stays explicit rather than presenting the declaration as the guaranteed executed implementation.

A function-call edge never gets inferred from matching names, an import list, a type annotation, a method reference, a function passed as a callback, or textual substring matching. A constructor invocation can count as a call if its target resolves. Dynamic imports and indirect dispatch only get recorded to the extent the analyzers can support a defensible target.

#### Deduplication and Provenance

Multiple occurrences between the same caller and callee can collapse into one visible edge, but every call site stays in that edge's evidence collection. Indexer identity and diagnostics stay around internally for troubleshooting. Duplicate SCIP occurrences and AST references get merged using normalized file, range, symbol, and relationship kind, never display names.

The core produces consistently ordered nodes, edges, evidence, and diagnostics for identical inputs. That gives reproducible tests, stable UI selection, and room to change the contract later without needing a database.

### Building the Dependencies

#### File and Module Edges

Dependency declarations get identified using syntax plus language-aware resolution. Local project targets resolve through the right compiler or indexer. The import statement's location, the imported spelling, aliased targets, type-only status, and the source module all get preserved. Repeated declarations between the same file/module endpoints get aggregated, but all the evidence stays.

Third-party package imports can be recorded as explanatory external names without becoming graph nodes by default. Re-exports and aliases resolve through actual symbol bindings, not naive filename or identifier matching. Configuration-dependent edges get qualified when the active build context excludes some possible imports.

#### Function and Method Call Edges

For each potential call expression, the enclosing callable gets identified, local or nested functions included, the symbol occurrence tied to the callee expression gets pulled, bound to a declaration using the semantic index or compiler, the dispatch classified, and a call edge only emitted when the relationship actually holds up.

The caller can live in any directory. Nested functions get their own identities; a call inside a nested function doesn't automatically belong to the outer function. Calls from module-level initialization can stay in the inspection evidence without a fictional function node invented for them. Imported symbols used as values show up as references, not calls.

Different language adapters give different precision: a direct Go function call, a statically resolved Java overload, a Python dynamic attribute call, and a C++ virtual call don't carry the same certainty. Coverage and unresolved diagnostics need to reflect that instead of forcing one universal success label on everything.

#### Circular Dependencies

Tarjan's strongly connected components algorithm runs over the directed, resolved file-level graph. Components with more than one vertex, plus self-dependency edges, mean a cycle. The participating nodes and edges get highlighted in the file view. Enumerating every elementary cycle with Johnson's algorithm isn't worth it for what this product needs to do; it's not worth the combinatorial cost.

Where package nodes are involved, cycles get labeled at the right abstraction level. A package-level cycle never turns into a claim about specific source files without evidence for it.

### Backend and HTTP

#### Running the Analysis

Node.js and Express stay as a thin orchestration server. Compiler and indexer CLIs run through Node's **`child_process.spawn`**, with argument arrays, a controlled working directory, a restricted environment, `shell: false`, bounded stdout/stderr, timeouts, cancellation, and cleanup of any descendant processes. CPU-heavy in-process parsing can use `worker_threads` or an isolated child process. The event loop never blocks on a large synchronous analysis.

A bounded in-memory job manager is enough for a tool this size. No Redis, queue broker, graph database, or persistent result store needed. Concurrency gets restricted so multiple repositories can't exhaust memory or CPU. Work can be cancelled on request, and completed results expire after a short, configurable retention window. If the process restarts, in-memory results are gone, by design.

#### API Shape

The existing ingestion entry points stay, with their execution semantics made consistent:

- `POST /api/analyze` takes a GitHub repository URL.
- `POST /api/analyze-upload` takes the user-selected project ZIP.
- A successful ingestion returns a short-lived analysis identifier; the browser pulls status and the completed graph from `GET /api/analyses/:id`.
- `DELETE /api/analyses/:id` requests cancellation and cleanup.

An analysis moves through an explicit lifecycle: `queued`, `running`, `complete`, `partial`, `failed`, or `cancelled`. The status response carries limited progress information and actionable analyzer diagnostics, not raw tool output. The completed response holds the versioned `CockpitGraph`. This asynchronous contract keeps a long-running indexer from holding one HTTP request open until it times out, without needing any infrastructure beyond the server process already in place.

`zod` handles validation at the HTTP and normalized-data boundaries where runtime checking actually protects something. Standard Node APIs cover filesystem operations, cleanup, process management, and logging; no wrapper layers just for the sake of more abstraction.

#### Resource Limits and Failures

Payload size, expanded ZIP size, file count, source depth, total source bytes, cloned repository size, subprocess runtime, subprocess memory, output size, and the number of concurrent analyses all get validated. These limits are configurable, with safe defaults. A malformed repository, an unsupported source extension, missing configuration, an indexer crash, a timeout, or a decoding failure has to produce a scoped diagnostic, not an empty graph quietly labeled as successful.

### Security and Trust

Everything coming from GitHub or an upload is untrusted. Parsing the source is fine; running arbitrary repository code, package lifecycle scripts, Makefiles, Maven/Gradle builds, shell scripts, dependency installers, or compiler plugins is not automatically allowed. Some semantic indexers internally invoke build tools or dependency discovery on their own, so the server needs to know and enforce each adapter's execution prerequisites before calling it.

A publicly reachable shared server can't enable build-capable indexing of untrusted projects without isolation strong enough to survive arbitrary code execution: a hardened sandbox or container with disabled or tightly controlled networking, CPU/memory/process limits, a temporary filesystem, and no host credentials. A temporary directory by itself is not a security sandbox. Without that isolation, build-dependent languages get partial coverage instead of a weaker trust boundary.

ZIP traversal, archive bombs, symlink escape, Git URL option injection, unexpected credential use, and unbounded process spawning all get guarded against. All API input gets validated. Error messages and stored source excerpts get sanitized so they don't leak server paths, environment variables, credentials, or unrelated local data. Uploaded code is ephemeral and never used for model training or external indexing services; analyses stay local to the deployed server unless that policy is deliberately changed.

### Client and Visualization

#### Renderer and Layout

React 19, TypeScript, and Vite make up the client, with **Cytoscape.js** as the sole renderer. **`elkjs`** arranges the visible graph in a browser worker, using layered positioning and routed edges. The client owns the worker lifecycle so it can cancel obsolete layouts and fall back to a grid when layout fails.

The client only lays out the visible subgraph, not thousands of hidden nodes. Search and focus run on adjacency indexes built from the normalized graph. Graph rendering is a projection of immutable analysis data; switching a selection never mutates the underlying dependency evidence.

#### User Interaction

The default view is the file/module graph. Selecting a file highlights its direct dependencies and dependents and opens a compact inspector. Selecting an edge shows the exact import/include statements, the referenced symbols, source lines, and any call evidence. A deliberate switch or expansion action opens the function-call view, scoped to the selected file or function and its neighborhood.

In the function view, node labels show qualified function/method names with short file context. An edge's inspector lists every supporting call site and the resolved target declaration. Clicking can jump to the next caller or callee. You can get back to the file view without losing your place. Search covers files and functions, and clearing the selection gets you back to an uncluttered canvas.

**`shiki`** handles syntax-highlighted, read-only source excerpts if the inspector can't present code clearly on its own. That's a presentation dependency, not a code-analysis component. Source evidence stays accessible even if highlighting fails for some reason.

#### Information Density

The layout calls for an expansive central canvas with a contextual, collapsible inspector. Ingestion stays visible but compact. No permanent metrics panels, multiple filter categories, architectural badges, or redundant graph engines cluttering things up.

Dependency direction gets explained consistently in the interface: **consumer/caller → supplier/callee**. A large repository should open into a readable, bounded view that can be selectively expanded. A graph that renders every single function isn't automatically useful just because it's technically possible to render it.

### Performance

Parse and semantically index the repository once per analysis job. Build adjacency indexes for incoming and outgoing neighbors, and cache file-to-function and function-to-file associations inside the returned graph or client-derived indexes. Source analysis doesn't get recomputed every time someone clicks around, filters, or opens the inspector.

Source snapshots stay bounded, and the expensive external indexers run outside the HTTP event loop under concurrency limits. Expensive layout operations can move off the main browser thread if profiling shows interaction stalls. Visible-subgraph extraction, incremental expansion, and evidence aggregation come before reaching for virtualized rendering or a different graph library.

This is built for modest-to-medium repositories, at least for now. Resource limits and explicit partial results beat silently accepting arbitrarily large repositories and dropping relationships without saying so. A graph database or a distributed compute layer isn't on the table unless the repository limits actually in place require one.

### Correctness and Testing

#### Semantic Accuracy

The graph gets validated against hand-verified fixture repositories for each language: same-file calls, cross-folder calls, re-exports, aliases, overloaded methods, nested functions, constructors, type-only references, packages/modules, missing dependencies, and unresolved dynamic calls. Precision (every reported edge is valid) matters more than recall (how many relevant static edges got found), and whatever coverage is missing gets disclosed.

A visual edge has to trace back to at least one source location and a defensible resolution rule. Every displayed file or function node has to link back to a real source entity or an explicitly named package abstraction. The graph should never invent a source file to stand in for a Go package, or mislabel a C header include as a function call.

#### Contract and Integration Testing

The repository's existing **`tsx`-based core tests** and **Node.js server tests** stay, along with **Playwright** for browser interactions and graph-selection flows. Deterministic golden outputs for the normalized graph, adapter compatibility tests against pinned indexer fixtures, API tests for cancellation and partial results, and security tests for path traversal, archive expansion limits, missing configs, and subprocess failures are all getting added. No new testing framework needed just for the sake of uniformity.

Source ranges get tested with Unicode identifiers, CRLF, comments, aliased imports, and multiple occurrences on one line. Edge aggregation has to preserve every call-site location. Running the same pinned repository and configuration twice should produce stable identities and output ordering.

#### Meaningful Diagnostics

The reason behind every unresolved relationship or partial analysis needs to be visible: missing build metadata, unsupported syntax, missing dependencies, dynamic dispatch, compiler errors, excluded files, or an indexer failure. These diagnostics describe analysis coverage, not architectural quality. They belong in the inspector or a small status area, not a separate reporting feature.

### Technology Decisions

#### Keeping

- **TypeScript**, **Node.js**, **npm workspaces** for the current monorepo and shared graph contracts.
- **Express** and **simple-git** for the existing HTTP and GitHub ingestion flow.
- **React 19**, **Vite**, **Cytoscape.js**, and **JSZip** for the existing web experience.
- **`ts-morph`** and the TypeScript compiler for the current JS/TS analysis path.
- **Multer**, with bounded disk-backed uploads instead of unbounded in-memory archive buffering.
- The existing **`tsx`** test tooling, Node server tests, and **Playwright** browser tests.

#### Adding Where It's Actually Needed

- **SCIP** and its TypeScript Protobuf bindings for semantic index ingestion.
- **`scip-python`**, **`scip-go`**, **`scip-java`**, **`scip-clang`** as language-specific semantic producers, subject to environment and security prerequisites.
- **`scip-typescript`** as a validated alternative to the existing JS/TS semantic implementation, not a mandatory duplicate of it.
- **`tree-sitter`** and the Python, Go, Java, C, and C++ grammars for syntax/call-site extraction.
- **`elkjs`** for dependency-oriented graph layout.
- **`yauzl`** for bounded ZIP extraction.
- **`zod`** for runtime input/contract validation.
- **`shiki`** for read-only syntax-highlighted evidence snippets.
- Node's built-in **`child_process`**, **`worker_threads`**, filesystem, timers, and cancellation primitives for safe orchestration. These aren't extra npm dependencies.

#### Removing or Avoiding

- **`adm-zip`**, once streaming-safe extraction replaces it.
- Environment-variable tracing, orphan/entry-point heuristics, architectural metrics panels, and exhaustive elementary-cycle enumeration.
- Databases, graph databases, Redis, queues, microservices, LLM services, telemetry platforms, and framework-specific plugins, unless something in the locked product contract actually demands one.

### Existing Repository Baseline and Compatibility

The current repository has a JS/TS source scanner and resolver, AST-based symbol usage reporting, cycle detection, GitHub and ZIP ingestion routes, and two Cytoscape views with a shared React inspector. The ingestion routes return `nodes`, `edges`, `analysis.cycles`, `symbolUsage`, and `functionGraph` directly. `functionGraph` contains callable nodes, caller-to-callee edges, module-level call evidence, unresolved sites, and coverage diagnostics. Source ranges use repository-relative paths and zero-based UTF-16 line and column offsets with exclusive ends. The inspector displays one-based coordinates and preserves the exclusive endpoint.

Existing code gets treated as something to reuse, not a reason to keep removed features alive in the public API. Whatever directly helps dependency correctness stays; data contracts that encode concepts the project has moved past get simplified or replaced. None of this is a wholesale rewrite; any replacement needs a real semantic or usability reason behind it.

### Acceptance Invariants

Cockpit satisfies its architectural contract only when the following statements hold:

- Every normal graph edge traces back to a real analyzed source occurrence, attributable to a specific analyzer and language context.
- Function-call edges represent actual calls, not just imports or identifier references; same-file and cross-folder calls get handled the same way.
- Directed edges go consumer/caller → supplier/callee, and the visual treatment never flips that meaning.
- Repository-relative paths, source ranges, overloaded declarations, and symbol identities stay unambiguous.
- Missing configuration, dynamic dispatch, unsupported constructs, and indexer failures never turn into invented confirmed edges.
- The server treats repository contents as untrusted, bounds its resource use, doesn't silently run project builds, and cleans up its temporary workspaces.
- A selected dependency's precise cause can be inspected, its neighborhood followed, and the surrounding graph returned to without the UI getting in the way.
- This stays a dependency explorer. Adding a language doesn't open the door to unrelated features.

### References

- [Cockpit repository](https://github.com/nikhilvirdi/cockpit)
- [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) and [ts-morph](https://ts-morph.com/)
- [SCIP protocol and schema](https://github.com/scip-code/scip) and [SCIP reference](https://github.com/scip-code/scip/blob/main/docs/scip.md)
- [scip-typescript](https://github.com/sourcegraph/scip-typescript)
- [scip-python](https://github.com/sourcegraph/scip-python)
- [scip-go](https://github.com/scip-code/scip-go)
- [scip-java](https://github.com/scip-code/scip-java) and [indexing prerequisites](https://scip-code.github.io/scip-java/docs/getting-started.html)
- [scip-clang](https://github.com/sourcegraph/scip-clang) and [Clang compilation database format](https://clang.llvm.org/docs/JSONCompilationDatabase.html)
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) and [Node bindings](https://github.com/tree-sitter/node-tree-sitter)
- [Cytoscape.js](https://js.cytoscape.org/), [Cytoscape ELK adapter](https://github.com/cytoscape/cytoscape.js-elk), and [ELK](https://eclipse.dev/elk/)
- [Node.js child-process API](https://nodejs.org/api/child_process.html), [yauzl](https://www.npmjs.com/package/yauzl), [Zod](https://zod.dev/), and [Shiki](https://shiki.style/)
