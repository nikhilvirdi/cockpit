## Cockpit

An interactive dependency explorer for JavaScript, TypeScript, Python, Go, Java, C, and C++. Analyze a public GitHub repository or local project folder to explore file and package dependencies and function calls with source evidence.

### What It Does

- **File Dependency Graph:** Explore imports and other language-specific module dependencies across the whole project.
- **Function Dependency Graph:** Start from a file or search for a function, then expand callers and callees across folders.
- **Dependency Inspection:** Inspect symbol references on file dependencies or open a resolved call to see each call site, target declaration, and available overload evidence.
- **Focused Navigation:** Search across the analyzed repository, switch between files and functions, and follow relationships without reanalyzing the source.
- **Circular Dependencies:** Cycles in the resolved file graph get flagged and highlighted.

### How It Works

Cockpit uses the TypeScript compiler for JavaScript and TypeScript. Python, Go, Java, C, and C++ use direct language analyzers in an isolated Linux container. Cytoscape.js renders both graph views, with ELK arranging them in a browser worker.

### Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Graph Visualization | Cytoscape.js, ELK |
| Backend | Node.js, Express |
| Repository & Folder Input | simple-git, JSZip, Multer, adm-zip |
| Code Analysis | ts-morph, TypeScript compiler, Python ast and Jedi, go/packages and go/types, JavaParser Symbol Solver, Clang LibTooling |
| Monorepo | npm workspaces |

### Language Support

| Language | Toolchain | Verified analysis |
|---|---|---|
| JavaScript and TypeScript | ts-morph 25.0.1 and TypeScript 5.7 | Local ESM and CommonJS dependencies, callable relationships and overload evidence |
| Python | CPython 3.13, Jedi 0.19.2 | Relative and absolute imports, local functions, aliases, recursion, and conservative constructor resolution |
| Go | Go 1.27.4, x/tools 0.52.0 | Package imports, nested module replacements, direct functions and concrete methods |
| Java | JDK 21, JavaParser and JavaSymbolSolver 3.27.1 | Imports and references, overloads, constructors, static and final methods |
| C and C++ | Clang LibTooling 19.1.7 | Compiler-resolved includes, direct calls, namespaces, templates and constructors |

Run `npm ci` and `npm run build`. Use Node.js 20.19+ on the 20.x line or Node.js 22.12 or later, and install Git for public repository ingestion.

#### Enable the native analyzers

Build the trusted toolchain image once using a local Linux Docker engine. Docker Desktop in Linux-container mode is supported on Windows.

```powershell
docker build -t cockpit-direct:local server/analyzers
$env:COCKPIT_ANALYZER_IMAGE = docker image inspect cockpit-direct:local --format '{{.Id}}'
npm run start:server
```

Run `npm run dev:client` in a second terminal. Both ingestion routes automatically run the configured tools for the source languages present. When the image or runtime is missing, Cockpit reports unavailable coverage and still displays discovered files. The image build fetches pinned analyzer libraries. Analysis itself runs offline in a read-only source snapshot with bounded scratch space, output, process count, CPU, memory, and execution time.

- Python uses project source and the trusted image's interpreter. Dynamic attributes and uncertain dispatch stay unresolved.
- Go uses checked-in module and workspace files and local replacements. Missing offline modules, CGO and external package drivers can limit coverage.
- Java discovers source roots from package layout, including conventional Maven and Gradle source directories. Operators can bake trusted dependency JARs into `/opt/cockpit/classpath` in a derived image. Cockpit does not run builds or resolve Maven or Gradle dependencies.
- Clang reads compilation databases below the project root. It supports language and standard options, macros, and workspace-local include paths. Prefer portable relative paths or paths rooted at `/workspace`. Unsupported flags, missing generated headers and conflicting translation-unit settings can limit coverage. Without matching metadata, Cockpit uses Clang defaults and reports partial coverage.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the result protocol and trust boundary.
