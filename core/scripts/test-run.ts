import * as path from 'path';
import * as fs from 'fs';
import { analyzeWorkspace } from '../src';

async function main() {
  const args = process.argv.slice(2);
  let inputTarget = '';
  let outputPath = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      outputPath = args[i + 1] || '';
      i++;
    } else if (!inputTarget && !args[i].startsWith('-')) {
      inputTarget = args[i];
    }
  }

  if (!inputTarget) {
    console.log('No directory path supplied as argument.');
    console.log('Usage: npx tsx scripts/test-run.ts <path-to-repo> [--output <path-to-json>]');
    console.log('Defaulting to core package directory for demonstration:\n');
  }

  const targetPath = path.resolve(inputTarget || path.join(__dirname, '..'));

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Target path does not exist: ${targetPath}`);
    process.exit(1);
  }

  console.log(`Analyzing repository at: ${targetPath}`);
  const startTime = Date.now();

  try {
    const graph = await analyzeWorkspace(targetPath);
    const duration = Date.now() - startTime;

    console.log('\n================ Dependency Graph Summary ================');
    console.log(`Total Nodes: ${graph.nodes.length}`);
    console.log(`Total Edges: ${graph.edges.length}`);
    console.log(`Time elapsed: ${duration}ms`);
    console.log('==========================================================\n');

    const sampleSize = Math.min(5, graph.edges.length);
    if (sampleSize > 0) {
      console.log(`Sample of ${sampleSize} edges:`);
      for (let i = 0; i < sampleSize; i++) {
        const edge = graph.edges[i];
        console.log(`  [${i + 1}] ${edge.from}  -->  ${edge.to}`);
      }
    } else {
      console.log('No internal edges found in the analyzed directory.');
    }

    console.log('\n================ Graph Analysis Summary ==================');
    const { analysis } = graph;

    console.log(`Cycles detected: ${analysis.cycles.length}`);
    if (analysis.cycles.length > 0) {
      const exampleCycle = analysis.cycles[0];
      const cycleString = [...exampleCycle, exampleCycle[0]].join('  -->  ');
      console.log(`  Example cycle: ${cycleString}`);
    }

    console.log('\n============== Symbol-Level Usage Precision ==============');
    const symbolUsages = graph.symbolUsage || [];
    console.log(`Total symbol usages found: ${symbolUsages.length}`);

    const sampleCount = Math.min(5, symbolUsages.length);
    if (sampleCount > 0) {
      console.log(`Sample of ${sampleCount} symbol usages:`);
      for (let i = 0; i < sampleCount; i++) {
        const u = symbolUsages[i];
        const typeTag = u.typeOnly ? ' [type-only]' : '';
        const noteTag = u.note ? ` (${u.note})` : '';
        console.log(
          `  [${i + 1}] ${u.importedSymbol} from ${u.fromFile} -> in ${u.usedInFile}:${u.line} scope "${u.usedInScope}"${typeTag}${noteTag}`
        );
      }
    } else {
      console.log('No internal symbol usages found.');
    }

    const { functionGraph } = graph;
    console.log(`\nFunction graph: ${functionGraph.nodes.length} callables, ${functionGraph.edges.length} edges, ${functionGraph.unresolved.length} unresolved sites (${functionGraph.coverage})`);

    // If --output flag provided, write full JSON to disk
    if (outputPath) {
      const resolvedOutput = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
      fs.writeFileSync(resolvedOutput, JSON.stringify(graph, null, 2), 'utf8');
      console.log(`\nWrote complete graph JSON to: ${resolvedOutput}`);
    }

    console.log('==========================================================\n');
    console.log('Graph engine and analysis completed successfully.');
  } catch (err) {
    console.error('Failed to build or analyze dependency graph:', err);
    process.exit(1);
  }
}

main();
