import { assertEq, suite, test } from './framework.js';
import { assign, parseSlots, DEFAULT_SLOTS } from '../viz/src/slots.js';

suite('viz card slots', () => {
    test('a view shown elsewhere swaps places', () => {
        assertEq(assign(['scoring', 'wheel', 'lattice'], 0, 'lattice'), ['lattice', 'wheel', 'scoring']);
    });
    test('a hidden view replaces the slot', () => {
        assertEq(assign(['lattice', 'wheel', 'scoring'], 2, 'spirals'), ['lattice', 'wheel', 'spirals']);
    });
    test('picking the same view is a no-op', () => {
        assertEq(assign(DEFAULT_SLOTS, 1, 'wheel'), DEFAULT_SLOTS);
    });
    test('parse: three distinct known views only', () => {
        assertEq(parseSlots('lattice,spirals,scoring'), ['lattice', 'spirals', 'scoring']);
        assertEq(parseSlots('lattice,lattice,scoring'), null);
        assertEq(parseSlots('lattice,spirals'), null);
        assertEq(parseSlots('lattice,spirals,nope'), null);
        assertEq(parseSlots(null), null);
    });
});
