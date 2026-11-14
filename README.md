## Cockpit

An interactive dependency explorer for JavaScript and TypeScript repositories. Give it a public GitHub repo URL or a local project folder to explore file dependencies and inspect their symbol references. The analysis API also returns function dependencies with source evidence.

### What It Does

- **File Dependency Graph:** Explore imports and other language-specific module dependencies across the whole project.
- **Function Dependency Graph (API):** Trace statically resolved calls between source-defined callables, with call-site and declaration ranges. The API reports unresolved and ambiguous calls alongside the graph.
- **Dependency Inspection:** Select a file relationship to see available symbol references, their enclosing scopes, and line numbers.
- **Focused Navigation:** Search for a file and follow its incoming and outgoing relationships.
- **Circular Dependencies:** Cycles in the resolved file graph get flagged and highlighted.

### How It Works

Cockpit uses `ts-morph` and the TypeScript compiler to inspect imports, scopes, and call expressions without executing the repository. Cytoscape.js renders the resolved file relationships.

### Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Graph Visualization | Cytoscape.js |
| Backend | Node.js, Express |
| Repository & Folder Input | simple-git, JSZip, Multer, adm-zip |
| Code Analysis | ts-morph, TypeScript compiler |
| Monorepo | npm workspaces |

### Language Support

**JavaScript and TypeScript** are supported today. See [ARCHITECTURE.md](ARCHITECTURE.md) for the planned function graph view and additional languages.
