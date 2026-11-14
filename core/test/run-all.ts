import './engine.test';
import './analysis.test';
import './symbolUsage.test';
import './functionGraph.test';
import { testScip } from './scip.test';

void testScip().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

