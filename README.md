## Cockpit

An interactive dependency explorer for JavaScript, TypeScript, Python, Go, Java, C, and C++. Analyze a public GitHub repository or local project folder to explore file and package dependencies and function calls with source evidence.

### What It Does

- **File Dependency Graph:** Explore imports and other language-specific module dependencies across the whole project.
- **Function Dependency Graph:** Start from a file or search for a function, then expand callers and callees across folders.
- **Dependency Inspection:** Inspect symbol references on file dependencies or open a resolved call to see each call site, target declaration, and available overload evidence.
- **Focused Navigation:** Search across the analyzed repository, switch between files and functions, and follow relationships without reanalyzing the source.
- **Circular Dependencies:** Cycles in the resolved file graph get flagged and highlighted.

### How It Works

Cockpit uses the TypeScript compiler for JavaScript and TypeScript. For other languages it matches Tree-sitter syntax to semantic definitions and references from SCIP indexes. Cytoscape.js renders both graph views, with ELK arranging them in a browser worker.

### Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Graph Visualization | Cytoscape.js, ELK |
| Backend | Node.js, Express |
| Repository & Folder Input | simple-git, JSZip, Multer, adm-zip |
| Code Analysis | ts-morph, TypeScript compiler, SCIP, Tree-sitter WASM |
| Monorepo | npm workspaces |

### Language Support

| Language | Analyzer | Verified indexing setup |
|---|---|---|
| JavaScript and TypeScript | Built-in `ts-morph` and TypeScript compiler | Node.js |
| Python | `scip-python` + Tree-sitter | v0.6.8 on Linux with Node.js and an explicit package environment |
| Go | `scip-go` + Tree-sitter | v0.2.9 on Windows with the Go toolchain and module metadata |
| Java | `scip-java` + Tree-sitter | v0.12.3 with JDK 21 and SemanticDB on Linux |
| C and C++ | `scip-clang` + Tree-sitter | v0.4.1 on Linux x64 with a compilation database |

Run `npm ci`, `npm run build`, `npm run start:server`, and, in another terminal, `npm run dev:client`. Use Node.js 20.19+ on the 20.x line or Node.js 22.12 or later. Install Git for public repository ingestion.

To analyze a language that uses SCIP, generate an index from the same source snapshot and place it at the corresponding project root. Use `index.scip`, or use separate `scip-python.scip`, `scip-go.scip`, `scip-java.scip`, and `scip-clang.scip` files when languages share a root. Upload the folder with the indexes or analyze a public repository that contains them. Cockpit uses the closest project configuration or index directory and reports coverage for each language and root. Missing or rejected indexes leave the source files searchable and mark semantic analysis unavailable. Successfully imported indexes report partial coverage because their completeness cannot be established from SCIP alone. Go imports point to packages. Indirect calls and virtual or dynamic dispatch can remain unresolved or show a possible declaration.

Run indexers in a trusted checkout or an isolated environment with the toolchain and build metadata for the project. Java indexing needs a compiler and the project classpath. C and C++ need a valid `compile_commands.json` and any generated headers. Official scip-clang v0.4.1 binaries are available for Linux x64 and macOS ARM64. For Windows, generate a Clang index in a compatible environment and copy it into the project. The tested scip-python and Java index producers also use Linux from Windows.

#### Optional server-managed indexing

By default the server reads existing indexes. To enable on-demand indexing, configure `COCKPIT_SCIP_PYTHON_IMAGE`, `COCKPIT_SCIP_GO_IMAGE`, `COCKPIT_SCIP_JAVA_IMAGE`, or `COCKPIT_SCIP_CLANG_IMAGE` with the SHA-256 ID or repository digest of a trusted, preinstalled image for a local Linux Docker engine. Its entrypoint receives the language as its single argument, runs from read-only `/workspace`, has writable scratch space in `/tmp`, and writes only the binary SCIP index to stdout. Bundle the supported indexer, compiler, and offline dependencies in the image. The server disables pulls and networking and bounds runtime, memory, processes, and output. Use a hardened, dedicated execution host for images that run build tools against untrusted repositories.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the analysis contract and [the integration fixtures](core/test/fixtures/multilang) for verified examples.
