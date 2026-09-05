import { Pitch } from './core/Pitch';

// Web MIDI API type declarations
declare global {
    namespace WebMidi {
        interface MIDIAccess {
            inputs: MIDIInputMap;
            outputs: MIDIOutputMap;
            addEventListener(type: 'statechange', listener: (event: MIDIConnectionEvent) => void): void;
            removeEventListener(type: 'statechange', listener: (event: MIDIConnectionEvent) => void): void;
        }

        interface MIDIInputMap {
            forEach(callback: (input: MIDIInput, key: string) => void): void;
            get(key: string): MIDIInput | undefined;
            has(key: string): boolean;
            keys(): IterableIterator<string>;
            values(): IterableIterator<MIDIInput>;
            entries(): IterableIterator<[string, MIDIInput]>;
            size: number;
        }

        interface MIDIOutputMap {
            forEach(callback: (output: MIDIOutput, key: string) => void): void;
            get(key: string): MIDIOutput | undefined;
            has(key: string): boolean;
            keys(): IterableIterator<string>;
            values(): IterableIterator<MIDIOutput>;
            entries(): IterableIterator<[string, MIDIOutput]>;
            size: number;
        }

        interface MIDIInput {
            id: string;
            manufacturer: string;
            name: string;
            type: 'input';
            version: string;
            state: 'connected' | 'disconnected';
            connection: 'open' | 'closed' | 'pending';
            addEventListener(type: 'midimessage', listener: (event: MIDIMessageEvent) => void): void;
            removeEventListener(type: 'midimessage', listener: (event: MIDIMessageEvent) => void): void;
        }

        interface MIDIOutput {
            id: string;
            manufacturer: string;
            name: string;
            type: 'output';
            version: string;
            state: 'connected' | 'disconnected';
            connection: 'open' | 'closed' | 'pending';
            send(data: number[] | Uint8Array, timestamp?: number): void;
            clear(): void;
        }

        interface MIDIMessageEvent extends Event {
            data: Uint8Array;
            receivedTime: number;
        }

        interface MIDIConnectionEvent extends Event {
            port: MIDIPort;
        }

        interface MIDIPort {
            id: string;
            manufacturer: string;
            name: string;
            type: 'input' | 'output';
            version: string;
            state: 'connected' | 'disconnected';
            connection: 'open' | 'closed' | 'pending';
        }
    }

    interface Navigator {
        requestMIDIAccess(options?: { sysex: boolean }): Promise<WebMidi.MIDIAccess>;
    }
}

// Musical letter names
export type LetterName = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

// Note display modes
export type NoteDisplayMode = 'letter' | 'solfege' | 'solfege_english' | 'letter_german' | 'number';

// Solfege names for each letter name
export const SOLFEGE_NAMES: Record<LetterName, string> = {
    C: 'Do',
    D: 'Re',
    E: 'Mi',
    F: 'Fa',
    G: 'Sol',
    A: 'La',
    B: 'Si'
};

export const SOLFEGE_NAMES_ENGLISH: Record<LetterName, string> = {
    C: 'Do',
    D: 'Re',
    E: 'Mi',
    F: 'Fa',
    G: 'So',
    A: 'La',
    B: 'Ti'
};

export const NUMBER_NAMES: Record<LetterName, string> = {
    C: '1',
    D: '2',
    E: '3',
    F: '4',
    G: '5',
    A: '6',
    B: '7'
};

// Letter name mapping to MIDI values
export const LETTER_NAME_VALUES: Record<LetterName, number> = {
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
    A: 9,
    B: 11
};

// Accidental values
export enum Accidental {
    NATURAL = 0,
    SHARP = 1,
    FLAT = -1,
    DOUBLE_SHARP = 2,
    DOUBLE_FLAT = -2,
    TRIPLE_SHARP = 3,
    TRIPLE_FLAT = -3

}

// Interval step values
export enum Step {
    UNISON = 0,
    SECOND = 1,
    THIRD = 2,
    FOURTH = 3,
    FIFTH = 4,
    SIXTH = 5,
    SEVENTH = 6,
    OCTAVE = 7,
    NINTH = 8,
    TENTH = 9,
    ELEVENTH = 10,
    TWELFTH = 11,
    THIRTEENTH = 12,
    FOURTEENTH = 13,
    FIFTEENTH = 14
}

// Interval type values
export enum IntervalType {
    DOUBLE_AUGMENTED = 'doubleAugmented',
    AUGMENTED = 'augmented',
    MAJOR = 'major',
    PERFECT = 'perfect',
    MINOR = 'minor',
    DIMINISHED = 'diminished',
    DOUBLE_DIMINISHED = 'doubleDiminished'
}

// Interval interface
export interface Interval {
    firstNote: Pitch;
    secondNote: Pitch;
    step: Step;
    type: IntervalType;
    ascending: boolean; // true if secondNote has higher MIDI value than firstNote
}



// All letter names in order
export const LETTER_NAMES: LetterName[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

// Letter name utilities
export const LetterNameUtils = {
    // Get next letter name in sequence
    getNext: (letter: LetterName, step: number = 1): LetterName => {
        const currentIndex = LETTER_NAMES.indexOf(letter);
        const newIndex = (currentIndex + step + 7) % 7;
        const result = LETTER_NAMES[newIndex];
        if (!result) {
            throw new Error(`Invalid letter name index: ${newIndex}`);
        }
        return result;
    },

    // Calculate steps between two letter names
    steps: (from: LetterName, to: LetterName): number => {
        const fromIndex = LETTER_NAMES.indexOf(from);
        const toIndex = LETTER_NAMES.indexOf(to);
        return (toIndex - fromIndex + 7) % 7;
    },

    // Get all letter names
    allCases: LETTER_NAMES
};

// Accidental utilities
export const AccidentalUtils = {
    // Convert to symbol.
    // ±1 → ♯/♭, ±2 → 𝄪/𝄫, |n|≥3 → n♯/n♭ (e.g. 3♯, 4♭)
    toSymbol: (value: number): string => {
        if (value === 0) return '';
        const abs = Math.abs(value);
        if (abs === 1) return value > 0 ? '♯' : '♭';
        if (abs === 2) return value > 0 ? '𝄪' : '𝄫';
        return `${abs}${value > 0 ? '♯' : '♭'}`;
    },

    // Convert from symbol
    fromSymbol: (symbol: string): number => {
        switch(symbol) {
            case '♯':
            case '#': return 1;
            case '♭':
            case 'b': return -1;
            case '𝄪': return 2;
            case '𝄫': return -2;
            case '': return 0;
            default: break;
        }
        // Parse numeric format: n♯, n♭ (e.g. "3♯", "4♭")
        const m = symbol.match(/^(\d+)([♯♭#b])$/);
        if (m) {
            const n = parseInt(m[1], 10);
            return (m[2] === '♯' || m[2] === '#') ? n : -n;
        }
        return 0;
    }
};

// Note display utilities
// TODO: pass pitchClass instead of letterName and accidental
export const NoteDisplayUtils = {
    // Convert letter name to display name based on mode
    toDisplayName: (letterName: LetterName, mode: NoteDisplayMode, showAccidental: boolean = false, accidental: Accidental = Accidental.NATURAL): string => {
        switch (mode) {
            case 'solfege':
                return SOLFEGE_NAMES[letterName] + (showAccidental ? AccidentalUtils.toSymbol(accidental) : '');
            case 'solfege_english':
                return SOLFEGE_NAMES_ENGLISH[letterName] + (showAccidental ? AccidentalUtils.toSymbol(accidental) : '');
            case 'letter_german':
                // German naming logic: B natural = H, B flat = B
                if (letterName === 'B') {
                    if (accidental === Accidental.NATURAL) {
                        return 'H';
                    } else if (accidental === Accidental.FLAT) {
                        return 'B';
                    }
                    // For B# and other accidentals, keep as B
                }
                return letterName + (showAccidental ? AccidentalUtils.toSymbol(accidental) : '');
            case 'number':
                return NUMBER_NAMES[letterName] + (showAccidental ? AccidentalUtils.toSymbol(accidental) : '');
            case 'letter':
            default:
                return letterName + (showAccidental ? AccidentalUtils.toSymbol(accidental) : '');
        }
    },

    // Convert display name back to letter name
    fromDisplayName: (displayName: string, mode: NoteDisplayMode): LetterName | null => {
        switch (mode) {
            case 'solfege':
                const solfegeEntry = Object.entries(SOLFEGE_NAMES).find(([_, solfege]) => solfege === displayName);
                return solfegeEntry ? solfegeEntry[0] as LetterName : null;
            case 'solfege_english':
                const solfegeEnglishEntry = Object.entries(SOLFEGE_NAMES_ENGLISH).find(([_, solfegeEnglish]) => solfegeEnglish === displayName);
                return solfegeEnglishEntry ? solfegeEnglishEntry[0] as LetterName : null;
            case 'letter_german':
                // Handle German: H -> B natural, B -> B flat
                if (displayName === 'H') return 'B';
                return displayName as LetterName;
            case 'number':
                const numberEntry = Object.entries(NUMBER_NAMES).find(([_, num]) => num === displayName);
                return numberEntry ? numberEntry[0] as LetterName : null;
            case 'letter':
            default:
                return displayName as LetterName;
        }
    }
}; 