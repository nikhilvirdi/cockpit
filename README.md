## Cockpit

An interactive dependency explorer for JavaScript and TypeScript repositories. Analyze a public GitHub repository or local project folder to explore file dependencies and function calls with source evidence.

### What It Does

- **File Dependency Graph:** Explore imports and other language-specific module dependencies across the whole project.
- **Function Dependency Graph:** Start from a file or search for a function, then expand callers and callees across folders.
- **Dependency Inspection:** Inspect symbol references on file dependencies or open a resolved call to see each call site, target declaration, and available overload evidence.
- **Focused Navigation:** Search across the analyzed repository, switch between files and functions, and follow relationships without reanalyzing the source.
- **Circular Dependencies:** Cycles in the resolved file graph get flagged and highlighted.

### How It Works

Cockpit uses `ts-morph` and the TypeScript compiler to inspect imports, scopes, and call expressions without executing the repository. Cytoscape.js renders the visible graph, with ELK arranging it in a browser worker.

### Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Graph Visualization | Cytoscape.js, ELK |
| Backend | Node.js, Express |
| Repository & Folder Input | simple-git, JSZip, Multer, adm-zip |
| Code Analysis | ts-morph, TypeScript compiler |
| Monorepo | npm workspaces |

### Language Support

**JavaScript and TypeScript** are supported today. See [ARCHITECTURE.md](ARCHITECTURE.md) for the analysis contract and planned language support.
