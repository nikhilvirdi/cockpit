import * as path from 'path';
import * as assert from 'assert';
import { buildDependencyGraph, analyzeDependencyGraph } from '../src';

function runAnalysisTests() {
  const fixturePath = path.resolve(__dirname, 'fixtures/analysis-project');
  console.log(`Running graph analysis tests against: ${fixturePath}`);

  const rawGraph = buildDependencyGraph(fixturePath);
  const graph = analyzeDependencyGraph(rawGraph, { rootDir: fixturePath });

  const { analysis } = graph;

  // Cycle detection assertions
  console.log(`Detected cycles:`, analysis.cycles);
  assert.deepStrictEqual(analysis.cycles, [
    ['src/cycle/node1.ts', 'src/cycle/node2.ts'],
    ['src/services/serviceA.ts', 'src/services/serviceB.ts', 'src/services/serviceC.ts']
  ], 'Should report cycle members in dependency direction');

  console.log('\nAll analysis assertions passed successfully! ✓');
}

runAnalysisTests();
