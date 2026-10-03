/**
 * In-app help. One overlay, one page per concept and per panel. It opens on the first visit, from the
 * `?` button in the toolbar, and from the small `i` on each panel (which jumps straight to that panel's
 * page). Content only: it explains the spelling model and how this debugger maps onto the shipped
 * library in `src/`. It never touches the engine.
 */

import { COMPUTER_KEYS } from './live.js';

interface Page { id: string; nav: string; title: string; body: string; }

/** Keyboard rows as physical keycaps, with each row's stagger in key widths. */
const KEY_ROWS: { offset: number; keys: [code: string, cap: string][] }[] = [
    { offset: 0, keys: [['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'],
        ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'], ['Minus', '-'], ['Equal', '=']] },
    { offset: 0.5, keys: [['KeyQ', 'Q'], ['KeyW', 'W'], ['KeyE', 'E'], ['KeyR', 'R'], ['KeyT', 'T'], ['KeyY', 'Y'],
        ['KeyU', 'U'], ['KeyI', 'I'], ['KeyO', 'O'], ['KeyP', 'P'], ['BracketLeft', '['], ['BracketRight', ']']] },
    { offset: 0.75, keys: [['KeyA', 'A'], ['KeyS', 'S'], ['KeyD', 'D'], ['KeyF', 'F'], ['KeyG', 'G'], ['KeyH', 'H'],
        ['KeyJ', 'J'], ['KeyK', 'K'], ['KeyL', 'L'], ['Semicolon', ';'], ['Quote', "'"]] },
    { offset: 1.25, keys: [['KeyZ', 'Z'], ['KeyX', 'X'], ['KeyC', 'C'], ['KeyV', 'V'], ['KeyB', 'B'], ['KeyN', 'N'],
        ['KeyM', 'M'], ['Comma', ','], ['Period', '.'], ['Slash', '/']] },
];
const WHITE_NAME = ['C', '', 'D', '', 'E', 'F', '', 'G', '', 'A', '', 'B'];
const BLACK_NAME = ['', 'C&sharp;<br>D&flat;', '', 'D&sharp;<br>E&flat;', '', '', 'F&sharp;<br>G&flat;', '',
    'G&sharp;<br>A&flat;', '', 'A&sharp;<br>B&flat;', ''];

/** The computer-keyboard map, drawn from the live input table so it cannot drift from it. A black key
 *  shows both names: which one is right is the speller's call. */
function keyboardMap(): string {
    const rows = KEY_ROWS.map(({ offset, keys }) => {
        const cells = keys.map(([code, cap]) => {
            const midi = COMPUTER_KEYS[code];
            if (midi === undefined) return `<span class="kb-key kb-off" data-code="${code}"><i>${cap}</i></span>`;
            const pc = midi % 12;
            const white = WHITE_NAME[pc]!;
            const name = white ? `${white}${Math.floor(midi / 12) - 1}` : BLACK_NAME[pc]!;
            return `<span class="kb-key ${white ? 'kb-white' : 'kb-black'}" data-code="${code}"><i>${cap}</i><b>${name}</b></span>`;
        }).join('');
        return `<div class="kb-row" style="--kb-offset:${offset}">${cells}</div>`;
    }).join('');
    return `<div class="kb-map" aria-label="computer keyboard note map">${rows}</div>`;
}

const SEEN_KEY = 'enharmonic:help-seen';

/** Panel/section element id -> the help page its `i` opens. */
const PANEL_PAGE: Record<string, string> = {
    scoring: 'scoring',
    wheel: 'spiral',
    'live-tonnetz': 'tonnetz',
    tonnetz: 'tonnetz',
    pianoroll: 'notation',
    transport: 'transport',
};

const PAGES: Page[] = [
    {
        id: 'overview', nav: 'Overview', title: 'What this is',
        body: `
<p>A debugger for the <b>enharmonic</b> speller. It runs the shipped library
(<a href="https://github.com/alexisdoualle/enharmonic/tree/main/src" target="_blank" rel="noopener"><code>src/</code></a>)
over a piece, note by note, and shows each decision. It does not re-implement the speller; it only reads
what the engine commits.</p>

<p><b>The problem.</b> MIDI gives pitch numbers. Note 61 is one piano key, but on paper it can be
C&sharp;, D&flat; or B&#x1D12A;. Choosing the letter and accidental is enharmonic spelling. The choices
sound the same, but only one fits the music around it.</p>

<p><b>Two things to get right.</b></p>
<ul>
<li><b>Coherence</b>: the intervals inside a passage. E&flat;&ndash;G&ndash;B&flat; is a triad;
E&flat;&ndash;G&ndash;A&sharp; is not.</li>
<li><b>The side</b>: which side of the spiral of fifths the passage is written on (C&sharp; or D&flat;).
A whole passage on the other side still reads fine, it is just notated differently.</li>
</ul>

<p><b>Three tiers.</b> Each note is scored against the composer's spelling:</p>
<ul>
<li><span class="k correct">correct</span>: matches the score.</li>
<li><span class="k flipped">flipped</span>: right pitch, with the whole passage coherently on the other
side. Not an error.</li>
<li><span class="k wrong">wrong</span>: a note that did not move with its neighbours.</li>
</ul>
<blockquote class="help-quote"><b>Example.</b> The composer wrote E&flat;&ndash;G&ndash;B&flat;. On the
other side it is D&sharp;&ndash;F&#x1D12A;&ndash;A&sharp;: <span class="k flipped">flipped</span>, not
wrong. If the speller writes D&sharp;&ndash;G&ndash;A&sharp;, the G is <span class="k wrong">wrong</span>:
it should have moved to F&#x1D12A; with the others.</blockquote>
`,
    },
    {
        id: 'model', nav: 'The model', title: 'How a note is spelled',
        body: `
<p>No key detection. Spelling comes from four rules. This is <code>CoreSpeller</code>
(<code>src/core.ts</code>); the other modes build on it.</p>

<ol>
<li><b>Interval scoring.</b> Of a pitch's possible spellings, pick the one with the most consonant
intervals against the current scale. Fifths and thirds score up; augmented and diminished intervals score
down. The scale settles into a key without one ever being named.</li>
<li><b>Seven letters.</b> The scale holds one spelling per letter, A to G. Each note replaces its letter's
slot, so spelling a note means choosing its letter.</li>
<li><b>Recency guard.</b> Interval scoring only compares against the other letters, so it misses A&flat;
right after A. The guard penalises respelling a letter within a few onsets. It stops flicker, not
modulation.</li>
<li><b>Spiral fold.</b> If the scale's average drifts more than 8 fifths from D, every slot moves one comma
back (E&sharp; becomes F, B&sharp; becomes C). It stops the scale walking a comma sharp.</li>
</ol>

<p><b>Why the side is separate.</b> D&flat;&ndash;F&ndash;A&flat; and C&sharp;&ndash;E&sharp;&ndash;G&sharp;
have the same intervals, so interval scoring can't choose between them. That needs an absolute position.
The fold is the coarsest one: it only catches a large drift. The frame (see <b>Spiral</b>), which the other
modes add, sets the side passage by passage.</p>
`,
    },
    {
        id: 'modes', nav: 'Speller modes', title: 'The four spellers (and the control)',
        body: `
<p>The <b>speller</b> menu picks which library entry point runs. Each mode adds one idea and makes fewer
wrong notes, at some cost in latency.</p>

<ul>
<li><b>&#9312; Core</b> &nbsp;<code>new CoreSpeller()</code><br>The four rules, no frame. The most wrong
notes, but it already reads intervals well. Real-time.</li>
<li><b>&#9313; real-time</b> &nbsp;<code>new Speller()</code><br>Core plus a diatonic frame that sets the
side as the music plays. The default. Real-time.</li>
<li><b>&#9314; look-ahead</b> &nbsp;<code>new Speller({ lookAhead: true })</code><br>Real-time plus a
short buffer, so a note can wait to see where it goes (a note rising to F&sharp; is E&sharp;, not F). Near
real-time. Turn it on with the <b>look-ahead</b> checkbox.</li>
<li><b>&#9315; two-pass</b> &nbsp;<code>spellTwoPass(notes)</code><br>Offline. A forward and a backward
pass agree on the side over the whole piece. The most accurate.</li>
<li><b>&#8856; control</b><br>A fixed line-of-fifths window (as in music21), for comparison. Not part of
the library.</li>
</ul>
<p>Switch modes on one piece and step through: they mostly differ on the side, at modulations.</p>
`,
    },
    {
        id: 'transport', nav: 'Transport & keys', title: 'Playback and shortcuts',
        body: `
<p>The transport bar moves the playhead by onset (notes struck together are one onset).</p>
<ul>
<li><b>Space</b>: play / pause. It first stops a recording, or the free take's write head.</li>
<li><b>&larr; &rarr;</b>: one onset. <b>Home / End</b>: start / end. Drag the scrub bar to scrub.</li>
<li><b>Enter</b>: record. <b>Backspace / Delete</b>: remove a note. <b>&#8984;Z</b>: undo. See
<b>Record &amp; export</b>.</li>
<li><b>tempo</b>: playback speed (centre is 1&times;). <b>sync</b>: delays the playhead to match audio
latency; raise it for Bluetooth headphones.</li>
<li><b>&#128266;</b>: plays each onset on a small synth. <b>&#127929; MIDI</b>: connects a MIDI keyboard
(see <b>Play live</b>).</li>
<li><b>&#8984;/Ctrl+C</b>: copies the current onset as text (settings, state, scoring) to paste to an
agent. <b>&#8984;/Ctrl+&#8679;+C</b> copies the whole run.</li>
</ul>
`,
    },
    {
        id: 'live', nav: 'Play live', title: 'Play notes yourself',
        body: `
<p>The computer keyboard is a small piano. Keys play into the real-time speller. Try it here: the keys
below light up and sound, without recording.</p>
${keyboardMap()}
<ul>
<li><b>Upper piano</b>: the <b>Q</b> row is the white keys C4 to G5, the number row the black keys.</li>
<li><b>Lower piano</b>: the <b>Z</b> row is the white keys C3 to E4, <b>S D G H J</b> the black keys.
<b>, . /</b> repeat C4, D4, E4.</li>
<li>Keys go by position: AZERTY and other layouts work the same.</li>
<li>Hold keys together for a chord. A key with Shift, Alt, Ctrl or &#8984; held plays nothing, so browser
shortcuts still work. Space, the arrows, Home and End stay transport keys.</li>
</ul>

<p><b>MIDI keyboard.</b> <b>&#127929; MIDI</b> connects every MIDI input. The browser asks for permission on
the first click; after that it connects on its own. The button turns green while a keyboard is connected.
Notes play on the synth as loud as you play them (turn off &#128266; if your instrument has its own sound).
The sustain pedal works. The button is hidden if the browser has no Web MIDI.</p>

<p><b>Play.</b> Just play: the fixture menu switches to <b>&#127929; free</b>, and every panel follows on the
same engine as the pieces. Nothing is graded, so notes take their letter's colour. Keys within 50 ms count
as one chord. While you play, the take is spelled in real time; look-ahead and two-pass re-spell it a
second after you stop.</p>

<p>The grey line on the roll is the write head: where the next note lands. When you let go, it runs to the
end of the bar and stops. Rests inside a bar keep their length, and a new phrase starts on a downbeat.
<b>Space</b> stops it early.</p>

<p>The roll shows bar and beat lines from the tempo and time signature in the transport bar. The free take
is not quantised to them. To play on a metronome, see <b>Record &amp; export</b>.</p>
`,
    },
    {
        id: 'record', nav: 'Record & export', title: 'Record, fix and export',
        body: `
<p>Two takes sit at the top of the fixture menu:</p>
<ul>
<li><b>&#127929; free</b>: whatever you play, in free time.</li>
<li><b>&#127929; metronome</b>: recorded with <b>&#9679; record</b>, on a metronome grid.</li>
</ul>

<table class="help-keys">
<tr><td><b>Enter</b> or <b>&#9679; record</b></td><td>count in four clicks, then record</td></tr>
<tr><td><b>Space</b></td><td>stops what is moving: a recording, playback, the free take's write head; otherwise plays</td></tr>
<tr><td>click a note or empty roll</td><td>in the metronome take: move the red line to that bar</td></tr>
<tr><td><b>Backspace</b> / <b>Delete</b></td><td>remove the note under the playhead</td></tr>
<tr><td><b>&#8984;Z</b> / Ctrl+Z</td><td>undo the last recording, deletion or clear</td></tr>
<tr><td><b>clear</b> or <b>&#8679;X</b>, twice</td><td>empty the take shown</td></tr>
</table>

<p><b>Record.</b> <b>&#9679; record</b> (or <b>Enter</b>) counts in four clicks at the tempo and time
signature beside it, then records into <b>&#127929; metronome</b>. <b>&#9632; stop</b> or <b>Space</b> ends
it. The red line follows the time. From anywhere else, it starts the metronome take over from bar 1
(&#8984;Z brings the old one back).</p>

<p><b>Add on top.</b> In the metronome take, click a note or the empty roll to put the red line at the start
of that bar, then record. You hear the take from the bar before, and what you play is added. After a
recording the line waits at the end, so recording again carries on. The take keeps its tempo and time
signature.</p>

<p><b>Export.</b> <b>&#10515; MusicXML</b> writes a score for MuseScore, Sibelius or Dorico: the shown
speller's spellings on a grand staff, the key signature from the real-time frame, and the rhythm rounded to
16ths. The metronome take uses its grid; the free take gets 4/4 and an estimated tempo. Nobody has checked
the spelling: it is the speller's own.</p>

<p>Both takes are kept across reloads, in this browser.</p>
`,
    },
    {
        id: 'import', nav: 'Import a score', title: 'Import your own score',
        body: `
<p><b>&#8613; import</b> (next to the fixture menu), or a file dropped on the page, loads your own score.
The format is MusicXML: <code>.musicxml</code>, <code>.xml</code> or compressed <code>.mxl</code>. Every
notation app exports it.</p>

<p>MusicXML keeps the composer's spelling, so an import is graded like the built-in pieces. A MIDI file has
no spelling to grade against, so it isn't accepted.</p>

<p>An import stays in this browser session. It is never uploaded, and it shows in the fixture menu as
<b>&#8613; &lt;name&gt; (imported)</b> until you import another.</p>

<p><b>Read:</b> parts, chords, ties, voices, and transposing instruments (converted to concert pitch).
<b>Skipped:</b> grace notes. Repeats play once, as written. So the note count can differ from the printed
score. A message after import lists what was skipped or converted.</p>
`,
    },
    {
        id: 'notation', nav: 'Staff & roll', title: 'The staff and the piano roll',
        body: `
<p>Both show the same spellings: one as notation, one over time.</p>
<ul>
<li><b>Staff</b>: the passage on a grand staff, as the engine spelled it.</li>
<li><b>Piano roll</b>: each note as a bar, pitch going up and time going across, coloured by tier
(<span class="k correct">correct</span> / <span class="k flipped">flipped</span> /
<span class="k wrong">wrong</span>). The playhead marks the current onset.</li>
</ul>
<p>A wrong note stands out on the roll: one off-colour bar in a run. <code>&#127919;</code> adds an
experimental, display-only read of the local and home key under the roll.</p>
`,
    },
    {
        id: 'scoring', nav: 'Scoring panel', title: 'Reading a spelling decision',
        body: `
<p>This panel shows the current note's decision, with the engine's own numbers.</p>
<p><b>Surface rows.</b> The 7-letter scale the engine holds right now.</p>
<ul>
<li><b>frame</b>: the plain diatonic collection (the side, before chromatic notes).</li>
<li><b>surface</b>: the frame with its current alterations. Candidates are scored against it.</li>
</ul>
<p><b>Candidate table.</b> Each spelling of the struck pitch, with its score.</p>
<ul>
<li><code>base</code>: interval consonance against the surface (rule 1).</li>
<li>the other columns: what each mechanism adds or takes away (recency guard, look-ahead, side leash,
vertical guard, depending on the mode).</li>
<li><b>&#9654;</b> marks the winner: the highest <code>base</code> plus the rest.</li>
</ul>
<p>When a note is wrong, the table shows which term beat the coherent spelling.</p>
`,
    },
    {
        id: 'spiral', nav: 'Spiral (side)', title: 'The spiral of fifths and the frame',
        body: `
<p>The spiral is the line of fifths coiled up. Go up by fifths (F, C, G, D, ...) and after one full turn
you land a comma over: the same key spelled the other way (D&flat; becomes C&sharp;). Which turn a passage
sits on is the <b>side</b>.</p>
<p>The <b>frame</b> on the spiral is the diatonic collection the engine holds: the side it has chosen. In
real-time mode the frame is read from the recent pitches, kept on the nearest turn, and held so one
chromatic note can't flip it. When the music modulates far enough, the frame moves a comma over and the
spelling flips with it.</p>

<blockquote class="help-quote"><b>Why the side is hard.</b> Coherence stays high in every mode, but the
side doesn't always have one answer. Some of it is convention: a piece is in A&flat; major, not G&sharp;
major. Some is a free choice: C&sharp; and D&flat; major are the same key. Some is timing: where in a
passage the side should turn. A real-time speller commits as it goes, so at a modulation it can flip half
a passage and leave a seam. Only two-pass, which reads the whole piece, can put the flip in the right
place. Chopin's Prelude Op. 28 No. 15 shows it: going from D&flat; major to the parallel minor, he writes
C&sharp; minor, not D&flat; minor.</blockquote>

<p><b>Two ways to hold the side.</b> The <code>mean</code> button in the spiral panel switches real-time
and look-ahead between them. Both move the collection a comma when it drifts too far, and both resist a
single chromatic note.</p>
<ul>
<li><b>diatonic frame</b> (default): an explicit collection, re-read at each onset and held with
hysteresis. It stays steady through passing chromatic notes, so there are fewer wrong notes. At a key
change it holds the old collection longer, so more of the new section comes out flipped. The key lane sits
on the frame.</li>
<li><b>mean</b>: the seven letters drift as notes come in, and the side is their average position, moved
back a comma past a threshold. It turns faster at a key change, so it matches the composer's side more
often on music with many keys (Bach's WTC book II), at the cost of a few more wrong notes. The key lane is
read separately, so it no longer lines up with the frame. Try it on Op. 28 No. 15.</li>
</ul>
`,
    },
    {
        id: 'tonnetz', nav: '3D Tonnetz', title: 'The harmonic lattice',
        body: `
<p>The Tonnetz places every spelling in harmonic space: one lattice over the line of fifths, on three
axes.</p>
<p class="help-eq">n = x + 4y + 7z</p>
<p><code>n</code> is the note's position on the line of fifths (C = 0).</p>
<ul>
<li><b>x</b>: one fifth per step.</li>
<li><b>y</b>: one major third per row (+4), so triads form triangles.</li>
<li><b>z</b>: one accidental per layer (+7): the same letter, one sharper. A letter's spellings stack in a
column: F&#x1D12B;, F&flat;, F, F&sharp;, F&#x1D12A;.</li>
</ul>

<blockquote class="help-quote"><b>Intervals.</b> An interval is a difference in <code>n</code>, heard as
the shortest move on the three axes. C to E is four fifths (4,0,0), heard as one major third (0,1,0). C to
C&sharp; is (7,0,0), heard as one accidental (0,0,1): an augmented unison. B to F is six fifths down, heard
as a fifth with one accidental down (1,0,-1): a diminished fifth. A fifth or a third is consonant, a second
or a seventh is neutral, and a move on the accidental axis is dissonant. Rule 1 adds this up against every
letter of the frame.</blockquote>

<p>Since <code>n = x + 4y + 7z</code> has many solutions, the same note appears in many cells, so a note
lights up in several places at once. That's expected.</p>
<p>The 2D view shows the sounding pitch classes on the inner clock and their spellings on the outer
spiral. The 3D view shows the lattice: drag to orbit, scroll to zoom.</p>
`,
    },
];

let root: HTMLElement | null = null;
let navEl: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;

/** Build the overlay, add the toolbar button, mount the panel `i`s, and open on the first visit. */
export function initHelp(): void {
    build();
    const btn = document.createElement('button');
    btn.id = 'help-open';
    btn.className = 'help-open';
    btn.type = 'button';
    btn.textContent = '? help';
    btn.title = 'how this works: the model and the app';
    btn.addEventListener('click', () => openHelp());
    document.getElementById('toolbar')?.appendChild(btn);
    mountInfoButtons();
    let seen = false;
    try { seen = !!localStorage.getItem(SEEN_KEY); } catch { /* private mode */ }
    if (!seen) openHelp('overview');
}

/** Add the small `i` to each panel/section (re-added after a panel re-renders and wipes it). */
export function mountInfoButtons(): void {
    for (const [elId, page] of Object.entries(PANEL_PAGE)) {
        const host = document.getElementById(elId);
        if (!host || host.querySelector(':scope > .help-i')) continue;
        const i = document.createElement('button');
        i.className = 'help-i';
        i.type = 'button';
        i.textContent = 'i';
        i.title = 'what is this?';
        i.addEventListener('click', e => { e.stopPropagation(); openHelp(page); });
        // A card gets the `i` pinned to its corner; the transport is a control row, so it sits inline
        // at the end instead of floating over the sliders.
        if (elId === 'transport') i.classList.add('help-i-inline');
        else if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(i);
    }
}

/** Is the overlay currently showing? (so the transport keys can stand down while it is open) */
export function isHelpOpen(): boolean {
    return !!root && !root.hidden;
}

export function openHelp(pageId?: string): void {
    build();
    show(pageId ?? contentEl!.dataset.page ?? PAGES[0]!.id);
    root!.hidden = false;
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
}

function closeHelp(): void {
    if (root) root.hidden = true;
}

function show(pageId: string): void {
    const page = PAGES.find(p => p.id === pageId) ?? PAGES[0]!;
    contentEl!.dataset.page = page.id;
    contentEl!.innerHTML = `<h2>${page.title}</h2>${page.body}`;
    contentEl!.scrollTop = 0;
    navEl!.querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', (b as HTMLElement).dataset.page === page.id));
}

function build(): void {
    if (root) return;
    root = document.createElement('div');
    root.id = 'help-overlay';
    root.hidden = true;
    root.innerHTML = `
      <div class="help-backdrop"></div>
      <div class="help-dialog" role="dialog" aria-modal="true" aria-label="help">
        <nav class="help-nav" aria-label="help pages"></nav>
        <div class="help-content"></div>
        <button class="help-close" type="button" title="close (Esc)" aria-label="close">&times;</button>
      </div>`;
    document.body.appendChild(root);
    navEl = root.querySelector('.help-nav');
    contentEl = root.querySelector('.help-content');
    navEl!.innerHTML = PAGES.map(p => `<button type="button" data-page="${p.id}">${p.nav}</button>`).join('');
    navEl!.querySelectorAll('button').forEach(b =>
        b.addEventListener('click', () => show((b as HTMLElement).dataset.page!)));
    root.querySelector('.help-close')!.addEventListener('click', closeHelp);
    root.querySelector('.help-backdrop')!.addEventListener('click', closeHelp);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isHelpOpen()) { e.preventDefault(); closeHelp(); }
    });
    // The keyboard map lights the keys being held (live notes still play while the overlay is up).
    const light = (e: KeyboardEvent, on: boolean) => {
        if (on && (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) return;
        contentEl?.querySelector(`.kb-key[data-code="${e.code}"]`)?.classList.toggle('kb-down', on);
    };
    document.addEventListener('keydown', e => light(e, true));
    document.addEventListener('keyup', e => light(e, false));
}
