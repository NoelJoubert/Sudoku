// Soft piano-like sounds, synthesised with Web Audio (no sound files).
//
// Every puzzle gets a classical piece. Each digit you place plays the next
// note of its melody, so you perform the piece as you solve; finished rows,
// cages and lines play chords in its key; solving plays its opening phrase.
// Or, in 'scale' style, each digit plays its own note of the piece's scale.
(function (root) {
'use strict';

// Melodies are "note:beats" (R is a rest). bass, when given, lines up with
// the melody note for note.
const PIECES = [
    { id: 'ode', title: 'Ode to Joy', by: 'Beethoven', bpm: 132, key: 'D4', chord: ['D3', 'F#3', 'A3', 'D4', 'F#4'],
        melody: 'F#4:1 F#4:1 G4:1 A4:1 A4:1 G4:1 F#4:1 E4:1 D4:1 D4:1 E4:1 F#4:1 F#4:1.5 E4:.5 E4:2 ' +
            'F#4:1 F#4:1 G4:1 A4:1 A4:1 G4:1 F#4:1 E4:1 D4:1 D4:1 E4:1 F#4:1 E4:1.5 D4:.5 D4:2' },
    { id: 'elise', title: 'Für Elise', by: 'Beethoven', bpm: 150, key: 'A3', minor: true, chord: ['A2', 'E3', 'A3', 'C4', 'E4'],
        melody: 'E5:.5 D#5:.5 E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5 A4:1.5 C4:.5 E4:.5 A4:.5 B4:1.5 E4:.5 G#4:.5 B4:.5 C5:1.5 ' +
            'E4:.5 E5:.5 D#5:.5 E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5 A4:1.5 C4:.5 E4:.5 A4:.5 B4:1.5 E4:.5 C5:.5 B4:.5 A4:2' },
    { id: 'nacht', title: 'Eine kleine Nachtmusik', by: 'Mozart', bpm: 132, key: 'G3', chord: ['G2', 'D3', 'G3', 'B3', 'D4'],
        melody: 'G4:1 R:.5 D4:.5 G4:1 R:.5 D4:.5 G4:.5 D4:.5 G4:.5 B4:.5 D5:2 C5:1 R:.5 A4:.5 C5:1 R:.5 A4:.5 C5:.5 A4:.5 F#4:.5 A4:.5 D4:2' },
    { id: 'prelude', title: 'Prelude in C', by: 'J. S. Bach', bpm: 76, key: 'C4', chord: ['C3', 'G3', 'C4', 'E4', 'G4'],
        melody: [
            'C4 E4 G4 C5 E5 G4 C5 E5', 'C4 E4 G4 C5 E5 G4 C5 E5',
            'C4 D4 A4 D5 F5 A4 D5 F5', 'C4 D4 A4 D5 F5 A4 D5 F5',
            'B3 D4 G4 D5 F5 G4 D5 F5', 'B3 D4 G4 D5 F5 G4 D5 F5',
            'C4 E4 G4 C5 E5 G4 C5 E5', 'C4 E4 G4 C5 E5 G4 C5 E5',
        ].join(' ').split(' ').map(n => n + ':.25').join(' ') },
    { id: 'canon', title: 'Canon in D', by: 'Pachelbel', bpm: 92, key: 'D4', chord: ['D3', 'A3', 'D4', 'F#4', 'A4'],
        melody: 'F#5:2 E5:2 D5:2 C#5:2 B4:2 A4:2 B4:2 C#5:2',
        bass: 'D3:2 A2:2 B2:2 F#2:2 G2:2 D2:2 G2:2 A2:2' },
    { id: 'lullaby', title: 'Lullaby', by: 'Brahms', bpm: 104, key: 'C4', chord: ['C3', 'G3', 'C4', 'E4', 'G4'],
        melody: 'E4:.5 E4:.5 G4:2 E4:.5 E4:.5 G4:2 E4:.5 G4:.5 C5:1 B4:1.5 A4:.5 A4:1 G4:1 ' +
            'D4:.5 E4:.5 F4:1 D4:1 D4:.5 E4:.5 F4:2 D4:.5 F4:.5 B4:.5 A4:.5 G4:1 B4:1 C5:3' },
    { id: 'twinkle', title: 'Ah vous dirai-je, maman', by: 'Mozart', bpm: 112, key: 'C4', chord: ['C3', 'G3', 'C4', 'E4', 'G4'],
        melody: 'C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2' },
];

const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = name => {
    const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
    return 12 * (+m[3] + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
};
const parse = text => text.trim().split(/\s+/).map(tok => {
    const [n, b] = tok.split(':');
    return { m: n === 'R' ? null : midi(n), beats: parseFloat(b) };
});
PIECES.forEach(p => {
    p.notes = parse(p.melody);
    p.bassNotes = p.bass ? parse(p.bass) : null;
    p.playable = p.notes.map((n, k) => k).filter(k => p.notes[k].m != null);
});

const MAJOR = [0, 2, 4, 5, 7, 9, 11, 12, 14];
const MINOR = [0, 2, 3, 5, 7, 8, 10, 12, 14];

let ctx = null, out = null, wet = null;
let enabled = true;

function impulse(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
}

function ensure() {
    if (!enabled) return null;
    if (!ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        out = ctx.createGain();
        out.gain.value = 0.75;
        const comp = ctx.createDynamicsCompressor();
        out.connect(comp);
        comp.connect(ctx.destination);
        const verb = ctx.createConvolver();
        verb.buffer = impulse(2.4);
        wet = ctx.createGain();
        wet.gain.value = 0.28;
        wet.connect(verb);
        verb.connect(comp);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
}

// One soft piano-ish note: a sine with a little 2nd and 3rd harmonic, a
// quick attack and a long natural fade.
function tone(m, at, len, vel, bus) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vel, at + 0.006);
    g.gain.exponentialRampToValueAtTime(vel * 0.35, at + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(5000, f * 6);
    g.connect(lp);
    lp.connect(bus ? bus.dry : out);
    lp.connect(bus ? bus.wet : wet);
    [[1, 'sine', 1], [2, 'triangle', 0.14], [3, 'sine', 0.05]].forEach(([mul, type, amp]) => {
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = type;
        o.frequency.value = f * mul;
        o.detune.value = (Math.random() - 0.5) * 4;
        og.gain.value = amp;
        o.connect(og);
        og.connect(g);
        o.start(at);
        o.stop(at + len + 0.05);
    });
}

const now = () => ctx.currentTime + 0.02;

function strum(notes, vel, gap, len, at, bus) {
    at = at == null ? now() : at;
    notes.forEach((m, k) => tone(m, at + k * gap, len, vel, bus));
}

const keyChord = piece => piece.chord.map(midi);

// The piece for a puzzle: chosen from its id, so every device agrees.
function pieceFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PIECES[h % PIECES.length];
}

// A digit was placed. n counts the digits placed so far on this puzzle, so
// placing them in turn walks through the melody, and taking one back and
// re-placing it replays the same note.
function place(piece, n, digit, style) {
    if (!ensure()) return;
    if (style === 'scale') {
        const scale = piece.minor ? MINOR : MAJOR;
        return tone(midi(piece.key) + 12 + scale[digit - 1], now(), 1.6, 0.2);
    }
    const k = piece.playable[((n % piece.playable.length) + piece.playable.length) % piece.playable.length];
    tone(piece.notes[k].m, now(), 1.6, 0.22);
    if (piece.bassNotes) tone(piece.bassNotes[k].m, now(), 2.2, 0.12);
}

// Something was completed: a gentle strum for a row, column or box, a
// rising sparkle for a cage or line, bigger for a combo.
function complete(piece, kind, count) {
    if (!ensure()) return;
    const c = keyChord(piece);
    if (kind === 'pair') return tone(c[c.length - 1] + 12, now(), 1.2, 0.08);
    if (count >= 2) return strum(c.concat(c.slice(2).map(m => m + 12)), 0.12, 0.05, 2.6);
    if (kind === 'line' || kind === 'cage') return strum(c.slice(1).map(m => m + 12), 0.1, 0.07, 1.8);
    strum(c, 0.11, 0.04, 2.2);
}

// The tune being played, if any. It has its own volume control (bus), so
// it can be faded out and stopped midway.
let playing = null;

function stop() {
    if (!playing) return;
    const p = playing;
    playing = null;
    clearTimeout(p.timer);
    const t = ctx.currentTime;
    [p.bus.dry, p.bus.wet].forEach(g => {
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.15);
    });
    setTimeout(() => { p.bus.dry.disconnect(); p.bus.wet.disconnect(); }, 400);
    if (p.onEnd) p.onEnd();
}

// The puzzle is solved: the piece's opening, then its home chord. Replaces
// any tune already playing. onEnd runs when it finishes or is stopped.
function finale(piece, delay, onEnd) {
    if (!ensure()) return 0;
    stop();
    const bus = { dry: ctx.createGain(), wet: ctx.createGain() };
    bus.dry.connect(out);
    bus.wet.connect(wet);
    const beat = 60 / piece.bpm;
    let at = now() + (delay || 0);
    piece.notes.forEach((n, k) => {
        const len = Math.max(0.7, n.beats * beat * 2.2);
        if (n.m != null) tone(n.m, at, len, 0.2, bus);
        if (piece.bassNotes) tone(piece.bassNotes[k].m, at, len + 0.6, 0.11, bus);
        at += n.beats * beat;
    });
    strum(keyChord(piece), 0.12, 0.06, 3.5, at + 0.1, bus);
    const secs = at + 3.5 - ctx.currentTime;
    const me = { bus, onEnd };
    me.timer = setTimeout(() => {
        if (playing !== me) return;
        playing = null;
        if (onEnd) onEnd();
    }, secs * 1000);
    playing = me;
    return secs;
}

const isPlaying = () => !!playing;

function setEnabled(on) {
    enabled = !!on;
    if (!enabled && ctx) { stop(); ctx.suspend(); }
}

// iOS only lets sound start inside a tap, so wake the audio on the first one.
function unlock() { if (enabled) ensure(); }

root.SudokuSound = { PIECES, pieceFor, place, complete, finale, stop, isPlaying, setEnabled, unlock };
})(typeof self !== 'undefined' ? self : this);
