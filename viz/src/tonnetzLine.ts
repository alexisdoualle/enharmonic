type Candidate = { key: string; spelling: string; central: boolean };
type LineOptions = { previous?: Iterable<string> };

const LOF_LETTERS = ['C', 'G', 'D', 'A', 'E', 'B', 'F'];
const LOF: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const spellingAtFifths = (n: number): string => {
    const step = LOF_LETTERS[((n % 7) + 7) % 7]!;
    return `${step}:${(n - LOF[step]!) / 7}`;
};

/**
 * Select the compact tonal line: seven adjacent fifth positions carrying seven distinct
 * active spellings. A spelling may occupy its direct central cell or a derived z cell.
 */
export function selectSevenNodeLoF(filled: Iterable<string>, options: LineOptions = {}): Set<string> | null {
    const candidatesByX = new Map<number, Candidate[]>();
    for (const key of filled) {
        const [x, y, z] = key.split(':').map(Number) as [number, number, number];
        if (y !== 0) continue;
        const candidates = candidatesByX.get(x) ?? [];
        candidates.push({ key, spelling: spellingAtFifths(x + 7 * z), central: z === 0 });
        candidatesByX.set(x, candidates);
    }
    const xs = [...candidatesByX.keys()];
    if (!xs.length) return null;

    const previousXs = options.previous === undefined ? [] : [...options.previous]
        .map(key => key.split(':').map(Number) as [number, number, number])
        .filter(([, y]) => y === 0)
        .map(([x]) => x);
    const previousStart = previousXs.length ? Math.min(...previousXs) : null;
    let best: { cells: string[]; centralCount: number; cost: number; start: number } | null = null;
    const lo = Math.min(...xs), hi = Math.max(...xs);
    for (let start = lo; start <= hi - 6; start++) {
        const columns = Array.from({ length: 7 }, (_, i) => candidatesByX.get(start + i) ?? []);
        if (columns.some(column => !column.length)) continue;
        const choose = (index: number, used: Set<string>, cells: string[], centralCount: number): void => {
            if (index === columns.length) {
                // With a previous line, moving the whole seven-position window is a real cost.
                // A z representation costs one local deformation; this makes a four-position
                // migration lose to an equally valid local alteration, while preserving the
                // old central-count preference when no prior line exists.
                const cost = previousStart === null
                    ? 0
                    : Math.abs(start - previousStart) + (7 - centralCount);
                const better = best === null
                    || (previousStart === null
                        ? centralCount > best.centralCount
                        : cost < best.cost
                            || (cost === best.cost && centralCount > best.centralCount))
                    || (cost === best.cost && centralCount === best.centralCount && start < best.start);
                if (better) best = { cells: [...cells], centralCount, cost, start };
                return;
            }
            const options = [...columns[index]!].sort((a, b) => Number(b.central) - Number(a.central) || a.key.localeCompare(b.key));
            for (const candidate of options) {
                if (used.has(candidate.spelling)) continue;
                used.add(candidate.spelling); cells.push(candidate.key);
                choose(index + 1, used, cells, centralCount + Number(candidate.central));
                cells.pop(); used.delete(candidate.spelling);
            }
        };
        choose(0, new Set(), [], 0);
    }
    return best ? new Set(best.cells) : null;
}
