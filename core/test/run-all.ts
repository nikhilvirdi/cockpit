import './engine.test';
import './analysis.test';
import './symbolUsage.test';
import './functionGraph.test';
import { testNative } from './native.test';

void testNative().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

