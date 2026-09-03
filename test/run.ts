import { summarize } from './framework.js';

await import('./speller.test.js');
await import('./viz.test.js');
await import('./examples/standalone.test.js');

const { passed, failed, failures } = summarize();
const total = passed + failed;

console.log();
console.log('Tests');
console.log('─'.repeat(60));
if (failed > 0) {
    for (const f of failures) {
        console.log(`  ✗ ${f.suite} › ${f.name}`);
        console.log(`      ${f.message}`);
    }
}
console.log(`  ${total} tests, ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
