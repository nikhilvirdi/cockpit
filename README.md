### Cockpit

Cockpit is a web app that generates an interactive dependency graph of a codebase. Point it at a GitHub repo URL or a local folder, and it parses the actual import statements, environment variable usage, and symbol references to build a ground truth map of how the project fits together.

The goal isn't to have an AI summarize your codebase in prose. It's to give you a graph you can trust and explore yourself: which files import what, where a given env variable actually gets used (including through re-exports and wrapper configs), which specific function in a file is the one using an import, where the circular dependencies are, and which files nothing else references.

Click a node and you get its fan in and fan out, its environment variable usage, and its import relationships. Click an edge and you get the exact symbols being used across it, down to the scope they're used in.

#### Stack

| Layer | Tech |
|---|---|
| Core engine | TypeScript, ts-morph |
| Backend | Node.js, Express, simple-git |
| Frontend | React, Vite, Cytoscape.js (Reagraph under evaluation) |
| Monorepo | npm workspaces |

Still in development.
