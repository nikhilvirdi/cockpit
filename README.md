## Cockpit

An interactive dependency explorer for source code repositories. Give it a public GitHub repo URL or a local project folder, and it builds a navigable graph of how the project's files and functions depend on each other, backed by source evidence you can inspect directly.

### What It Does

- **File Dependency Graph:** Explore imports and other language-specific module dependencies across the whole project.
- **Function Dependency Graph:** Trace resolvable calls between functions and methods, within a file or across folders.
- **Dependency Inspection:** Select a relationship to see the exact symbol, the calling scope, and the source location behind it.
- **Focused Navigation:** Search for a file or function, check its incoming and outgoing relationships, and expand the graph from there instead of staring at the whole thing at once.
- **Circular Dependencies:** Cycles in the resolved file graph get flagged and highlighted.

### How It Works

Cockpit never runs the code. It reads it. Language-aware analyzers resolve declarations and references, and a separate syntax pass picks out imports, function scopes, and call expressions.

Both kinds of evidence get combined into one dependency graph, then rendered as something interactive. A relationship that can't be resolved with real confidence is marked unresolved instead of guessed.

### Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Graph Visualization | Cytoscape.js, ELK |
| Backend | Node.js, Express |
| Repository & Folder Input | simple-git, JSZip, Multer, yauzl |
| Code Analysis | ts-morph, SCIP indexers, Tree-sitter |
| Monorepo | npm workspaces |

### Language Support

**JavaScript, TypeScript, Python, Go, Java, C, and C++**.