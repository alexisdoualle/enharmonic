/** Tiny assertion harness (no Jest/Vitest). */

export type TestFn = () => void;

const suites: { name: string; tests: { name: string; fn: TestFn }[] }[] = [];
let current: (typeof suites)[number] | null = null;

export function suite(name: string, fn: () => void): void {
    current = { name, tests: [] };
    suites.push(current);
    fn();
    current = null;
}

export function test(name: string, fn: TestFn): void {
    if (!current) throw new Error(`test("${name}") outside suite`);
    current.tests.push({ name, fn });
}

export function assertEq<T>(actual: T, expected: T, msg?: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(msg ?? `assertEq failed: ${a} !== ${e}`);
}

export function assert(cond: unknown, msg?: string): void {
    if (!cond) throw new Error(msg ?? 'assert failed');
}

export function summarize(): { passed: number; failed: number; failures: { suite: string; name: string; message: string }[] } {
    let passed = 0;
    let failed = 0;
    const failures: { suite: string; name: string; message: string }[] = [];
    for (const s of suites) {
        for (const t of s.tests) {
            try {
                t.fn();
                passed++;
            } catch (err) {
                failed++;
                failures.push({
                    suite: s.name,
                    name: t.name,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    return { passed, failed, failures };
}
