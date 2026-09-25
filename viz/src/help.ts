/**
 * In-app help. One overlay, one page per concept and per panel. It opens on the first visit, from the
 * `?` button in the toolbar, and from the small `i` on each panel (which jumps straight to that panel's
 * page). Content only: it explains the spelling model and how this debugger maps onto the shipped
 * library in `src/`. It never touches the engine.
 */

interface Page { id: string; nav: string; title: string; body: string; }

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
<p>A debugger for the <b>enharmonic</b> speller. It runs the real shipped library
(<a href="https://github.com/alexisdoualle/enharmonic/tree/main/src" target="_blank" rel="noopener"><code>src/</code></a>)
over a piece note by note and shows every decision it makes. Nothing here re-implements the speller: the
app only reads what the engine committed.</p>

<p><b>The problem.</b> MIDI gives pitch numbers. Note 61 is one key on the piano, but on paper it is
C&sharp; or D&flat;, or even B&#x1D12A;. Written music needs a letter (A to G) and an accidental.
Choosing them from a bare pitch number is enharmonic spelling. There is no audio difference; the
spellings mean different things to a reader, and only one fits the surrounding music.</p>

<p><b>Two things have to be right.</b></p>
<ul>
<li><b>Coherence</b>: the intervals inside a passage. E&flat;&ndash;G&ndash;B&flat; is a coherent triad;
E&flat;&ndash;G&ndash;A&sharp; is not.</li>
<li><b>The side</b>: which side of the spiral of fifths the passage is written on (the C&sharp; side or
the D&flat; side). A whole passage moved to the other side is still readable music, just notated
differently.</li>
</ul>

<p><b>Three tiers.</b> Every note is scored against the composer's spelling:</p>
<ul>
<li><span class="k correct">correct</span> matches the score.</li>
<li><span class="k flipped">flipped</span> is the right pitch with the whole passage coherently notated
on the other side. Not an error, just the other notation.</li>
<li><span class="k wrong">wrong</span> breaks the local consensus: a note that failed to move with its
neighbours.</li>
</ul>
<blockquote class="help-quote"><b>Flipped vs wrong, concretely.</b> Say the composer wrote the triad
E&flat;&ndash;G&ndash;B&flat;. The same three keys on the other side of the spiral are
D&sharp;&ndash;F&#x1D12A;&ndash;A&sharp;: a coherent flip, right intervals, just notated sharp instead of
flat. A passage spelled that way scores <span class="k flipped">flipped</span>, not wrong. Now suppose
the speller flips the outer notes but leaves the middle one behind and writes
D&sharp;&ndash;G&ndash;A&sharp;. The G no longer fits: a natural stranded between two sharps, an
incoherent chord. The rest of the passage is still a clean flip, but that G is
<span class="k wrong">wrong</span> because it did not move to the side its neighbours did (it should have
been F&#x1D12A;). Wrong is a note out of step with its own passage. Merely differing from what the
composer wrote is flipped, not wrong.</blockquote>`,
    },
    {
        id: 'model', nav: 'The model', title: 'How a note is spelled',
        body: `
<p>No key detection anywhere. Spelling falls out of three principles. This is <code>CoreSpeller</code>
(<code>src/core.ts</code>); every other mode builds on it.</p>

<ol>
<li><b>The 7-letter limit.</b> A running scale holds one spelling per letter A to G. Every note
overwrites its letter's slot. Spelling a note means choosing which letter to claim.</li>
<li><b>Interval scoring.</b> Among a pitch's enharmonic candidates, pick the one that forms the most
consonant intervals with the rest of the scale. Fifths and thirds reward, augmented and diminished
intervals punish. The scale drifts into key on its own, with no key ever named.</li>
<li><b>The recency guard.</b> Interval scoring only compares a candidate against the <i>other</i>
letters, so it misses a same-letter clash (A&flat; right after A&natural;). The guard penalises a letter
respelled at a different accidental within a few onsets. It blocks flicker, not real modulation.</li>
</ol>

<p><b>Why the side is separate.</b> Intervals are almost symmetric under a comma shift: D&flat;&ndash;F&ndash;A&flat;
has the same intervals as C&sharp;&ndash;E&sharp;&ndash;G&sharp;. So interval scoring cannot tell the two
sides apart. Picking the side needs an absolute position, not a relative one. That is the frame's job
(see <b>Spiral</b>), and it is what the real-time and two-pass modes add on top of the model here.</p>`,
    },
    {
        id: 'modes', nav: 'Speller modes', title: 'The four spellers (and the control)',
        body: `
<p>The <b>speller</b> selector switches which library entry point drives the run. Each rung adds one
idea and drops the wrong count, at some cost in latency.</p>

<ul>
<li><b>&#9312; Core</b> &nbsp;<code>new CoreSpeller()</code><br>The frameless baseline: the three
principles, one drifting scale, no side correction. Highest wrong%, but it already reads intervals well.
Real-time.</li>
<li><b>&#9313; real-time</b> &nbsp;<code>new Speller()</code><br>Core plus a diatonic frame that fixes
the side as the music plays. The production default. Real-time.</li>
<li><b>&#9314; look-ahead</b> &nbsp;<code>new Speller({ lookAhead: true })</code><br>Real-time plus a
small forward buffer, so a note can wait for its resolution before committing (an F&sharp;-bound note
spells E&sharp;, not F). Near-real-time. It is the <b>look-ahead</b> checkbox, on top of real-time.</li>
<li><b>&#9315; two-pass</b> &nbsp;<code>spellTwoPass(notes)</code><br>Offline. A forward and a backward
pass reconcile the side over the whole piece. The accuracy ceiling. A plain function, not a class.</li>
<li><b>&#8856; control</b><br>A fixed line-of-fifths window baseline (music21 style), for comparison
only. Not part of the shipped speller.</li>
</ul>
<p>Switch modes on the same piece and step through to see where they diverge: it is almost always the
side, at a modulation, not the intervals.</p>`,
    },
    {
        id: 'transport', nav: 'Transport & keys', title: 'Playback and shortcuts',
        body: `
<p>The transport bar drives the playhead. It steps by <b>onset</b> (all notes struck together are one
onset).</p>
<ul>
<li><b>Space</b> play / pause. <b>&larr; &rarr;</b> step one onset. <b>Home / End</b> jump to the start
or end. Drag the scrub bar to scrub.</li>
<li><b>tempo</b> sets playback speed (centre is 1&times;). <b>sync</b> delays the playhead to match audio
latency; raise it for Bluetooth headphones.</li>
<li><b>&#128266;</b> plays each onset through a small synth. <b>&#127929; MIDI</b> connects a keyboard so
you can feed live notes into the speller.</li>
<li><b>&#8984;/Ctrl+C</b> copies the current onset (settings, state, and the full scoring) as text to
paste to an agent. <b>&#8984;/Ctrl+&#8679;+C</b> copies the whole run.</li>
</ul>`,
    },
    {
        id: 'import', nav: 'Import a score', title: 'Import your own score',
        body: `
<p>The <b>&#8613; import</b> button, next to the fixture menu, loads a score of your own. You can also drop
a file anywhere on the page. The format is <b>MusicXML</b>: <code>.musicxml</code> or <code>.xml</code>,
and compressed <code>.mxl</code>. Every notation app exports it (MuseScore, Sibelius, Finale, Dorico).</p>

<p>MusicXML keeps the composer's own spelling, so an imported score is graded exactly like the built-in
fixtures: the speller sees only the pitches, and its output is scored against the notated letters, three
tiers and all. A plain MIDI file has no spelling to grade against, which is why the import is MusicXML,
not MIDI.</p>

<p>An import lives in this browser session only. It is never uploaded and never added to the corpus, and
it shows in the fixture menu as <b>&#8613; &lt;name&gt; (imported)</b> until you import another.</p>

<p><b>What this first version reads:</b> multiple parts, chords, ties, voices, and transposing instruments
(a clarinet or horn part is converted to concert pitch so it lines up with the rest). Grace notes are
skipped and repeats are not expanded (the written order plays once), so the note count can differ from the
printed score. A short message after import names anything that was skipped or converted.</p>`,
    },
    {
        id: 'notation', nav: 'Staff & roll', title: 'The staff and the piano roll',
        body: `
<p>Both views show the same committed spellings, one as notation and one over time.</p>
<ul>
<li><b>Staff</b>: the passage engraved from the spellings the engine committed. This is what the choice
of letter and accidental actually looks like on paper.</li>
<li><b>Piano roll</b>: every note as a bar, pitch up the y-axis, time across. Each bar is coloured by its
tier (<span class="k correct">correct</span> / <span class="k flipped">flipped</span> /
<span class="k wrong">wrong</span>). The playhead marks the current onset.</li>
</ul>
<p>Wrong notes are easiest to spot here: a lone off-colour bar in a run is a note that failed to move
with its neighbours. The <code>&#127919;</code> key-lanes toggle adds an experimental, display-only read
of the local and stable collection under the roll.</p>`,
    },
    {
        id: 'scoring', nav: 'Scoring panel', title: 'Reading a spelling decision',
        body: `
<p>This panel opens up the current note's decision, the same numbers the engine used.</p>
<p><b>Surface rows.</b> The 7-letter scale the engine is holding right now.</p>
<ul>
<li><b>frame</b>: the bare diatonic collection (the side, before any chromatic colour).</li>
<li><b>surface</b>: that collection with its live alterations, the scale a candidate is actually scored
against.</li>
</ul>
<p><b>Candidate table.</b> Every enharmonic spelling of the struck pitch, with its score.</p>
<ul>
<li><code>base</code> is the interval consonance against the surface (principle 2).</li>
<li>the remaining columns are the mechanism deltas: the recency guard, look-ahead, the side leash, the
vertical guard, and so on, depending on the mode.</li>
<li>the winner (<b>&#9654;</b>) is the one that maximises <code>base</code> plus the deltas. That is the
argmax the engine committed, nothing more.</li>
</ul>
<p>When a note reads wrong, this table shows why: which term outvoted the coherent spelling.</p>`,
    },
    {
        id: 'spiral', nav: 'Spiral (side)', title: 'The spiral of fifths and the frame',
        body: `
<p>The spiral is the line of fifths coiled up. Step by fifths (F, C, G, D, ...) and after one full turn
you land a comma over, on the same piano key spelled the other way (D&flat; and C&sharp;). That turn is
the <b>side</b>.</p>
<p>The <b>frame</b> drawn on the spiral is the diatonic collection the engine is holding: which turn of
the spiral the passage is being written on. It is the app's picture of the side decision.</p>
<p>Interval scoring cannot set this (it is comma-symmetric), so the frame does it with an absolute
position on the spiral. In real-time mode the frame is read from the recent raw pitch classes by
coverage, placed on the nearest turn for continuity, and held so one chromatic note cannot flip it. When
a passage modulates far enough, the frame folds a comma over, and the notation flips side with it.</p>

<blockquote class="help-quote"><b>Why the side is hard.</b> Coherence stays high in every mode, but the
side does not always have one right answer. Some of it is convention: a piece is A&flat; major, not
G&sharp; major. Some is genuinely arbitrary: C&sharp; and D&flat; major are the same key, equally valid
on paper. And some is a matter of timing, where in a passage the side turns over. A streaming speller
commits as it goes, so at a modulation it can flip half a passage and leave an incoherent seam; only
reading the whole piece offline (the two-pass mode) can place the flip where it belongs. Chopin's Prelude
Op. 28 No. 15 is the stock case: from D&flat; major to its parallel minor he writes C&sharp; minor, not
D&flat; minor, and only the whole phrase makes that clear.</blockquote>
<p><b>Two ways to hold the side.</b> Both do the same job, place the collection on the spiral, fold it a
comma when it drifts too far, and resist a single chromatic flipping it, but they hold it differently. The
<code>mean</code> button in the spiral panel switches real-time and look-ahead between them:</p>
<ul>
<li><b>diatonic frame</b> (the shipped default): the frame is an explicit collection, re-read each onset
from the recent raw pitch classes and held by hysteresis. It holds steady through passing chromatics, so
it makes fewer incoherent slips; the price is that at a key change it holds the old collection longer and
flips more of the new section (coherently) onto the other side. Here the frame, its collection, and the
detected key are one and the same number, so the key lane sits exactly on the frame.</li>
<li><b>mean</b>: the seven slots simply drift as notes commit, and the side is their running average
position on the spiral, folded back a comma once that average crosses a deadzone. The average re-orients
quickly at a key change, so on stitched multi-key material (Bach's WTC book II, dozens of keys back to
back) it matches the composer's notated side markedly more often, at the cost of a few more incoherent
slips. A second tell: the detected key (the key lane) is read separately from the drifting surface here,
so the key lane no longer lines up with the frame the way it does under the diatonic frame. Turn
<code>mean</code> on over Op. 28 No. 15 to watch the side move more freely where the frame holds it.</li>
</ul>`,
    },
    {
        id: 'tonnetz', nav: '3D Tonnetz', title: 'The harmonic lattice',
        body: `
<p>The Tonnetz lays every spelling out in harmonic space: one infinite lattice over the line of fifths,
projected onto three axes. The whole thing is one identity:</p>
<p class="help-eq">n = x + 4y + 7z</p>
<p><code>n</code> is the line-of-fifths position of the note (C = 0). Each axis is one interval:</p>
<ul>
<li><b>x</b>: a perfect fifth per step (the horizontal fifth chain).</li>
<li><b>y</b>: a major third per row (+4 on the line of fifths), so triads read as triangles.</li>
<li><b>z</b>: one accidental per layer (+7), the same letter one accidental sharper. Directly below any
node is the same letter one accidental flatter. A letter's spellings stack in a column:
F&#x1D12B;, F&flat;, F, F&sharp;, F&#x1D12A;.</li>
</ul>

<blockquote class="help-quote"><b>Reading an interval off the lattice.</b> An interval is a difference
in <code>n</code>, and the ear hears it as the nearest decomposition into the three axes.
C to E is four steps along the fifths (4,0,0), heard as one major third (0,1,0). C to C&sharp; is (7,0,0),
heard as one alteration (0,0,1), an augmented unison. B to F is six fifths down (-6,0,0), heard as a fifth
lowered by an alteration (1,0,-1), a diminished fifth. The quality reads straight off the move: a
neighbour in the fifths-and-thirds plane (a fifth or a third) is consonant, a farther step (a second or a
seventh) is neutral, and a move onto the alteration axis is dissonant. That is interval scoring
(principle 2), summed against every letter of the current frame.</blockquote>

<p>Because <code>n = x + 4y + 7z</code> has many integer solutions, the same note appears at many cells.
An in-scale note lights up in several places at once. That is inherent to the lattice, not a bug.</p>
<p>The 2D coiled view shows the sounding pitch classes on the central clock and the spelled targets on
the outer spiral. The 3D view shows the lattice itself: drag to orbit, scroll to zoom.</p>`,
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
}
