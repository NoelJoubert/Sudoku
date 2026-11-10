(() => {
'use strict';

const E = SudokuEngine;
const SFX = SudokuSound;
const API = 'api/state';
const COLOURS = ['#ff8e8e', '#ffbf6e', '#ffe866', '#94dc8c', '#7cc8ff', '#a99bff', '#f29ad8', '#c7c7cc', '#6e6e73'];
const DEFAULT_SETTINGS = { showMistakes: false, showConflicts: true, autoClean: true, highlightSame: true, sound: true, soundStyle: 'piece' };
// The middle-of-edge spots sit a little inward, clear of Kropki dots and X/V badges.
const CORNER_POS = [[20, 21], [80, 21], [20, 80], [80, 80], [50, 25], [50, 76], [24, 51], [76, 51], [50, 51]];
// Cells with a cage total keep the top for it: their marks sit in a small
// grid underneath, in order.
const CAGE_CORNER_POS = [[24, 43], [50, 43], [76, 43], [24, 61], [50, 61], [76, 61], [24, 79], [50, 79], [76, 79]];
const MODES = ['normal', 'corner', 'centre', 'colour'];
// Solved puzzles kept in full, so they can still be viewed and shared.
const KEEP_SOLVED_DEFS = 200;
const SHARE_BASE = 'https://noeljoubert.github.io/Sudoku/';

const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const board = $('board');

let state = null;      // everything that is saved
let cur = null;        // the puzzle being played
let sel = new Set();
// Digit pinned by a double-click/double-tap: its cells stay highlighted while
// other cells are selected, until another digit is pinned or the page
// background (outside the board and its controls) is clicked.
let pinnedDigit = 0;
let lastSel = -1;
let mode = 'normal';
let undoStack = [], redoStack = [];
let hintView = null;   // { target, cells, helperCells, mistakes }
let busy = false;
let dragging = false;

// ------------------------------------------------------------------ saving

let useLocal = false, saveTimer = null, dirty = false;

async function load() {
    try {
        const r = await fetch(API, { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        state = await r.json();
    } catch (e) {
        useLocal = true;
        try { state = JSON.parse(localStorage.getItem('sudoku-state') || '{}'); } catch (_) { state = {}; }
    }
    state.version = 1;
    state.settings = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
    state.puzzles = state.puzzles || {};
    state.order = state.order || [];
    state.queue = (state.queue || []).filter(d => d.grader === E.GRADER);
    state.counter = state.counter || 0;
    state.recentTypes = state.recentTypes || [];
    state.deleted = state.deleted || {};
}

// Marks the current puzzle as changed, so a sync can tell which copy is
// newer. Only real moves count: just opening a puzzle doesn't.
function touch() {
    if (cur) {
        cur.updatedAt = Date.now();
        if (!cur.startedAt) cur.startedAt = cur.updatedAt;
    }
    scheduleSync();
}

function save() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
}

function flush(leaving) {
    if (!dirty) return;
    dirty = false;
    clearTimeout(saveTimer);
    const body = JSON.stringify(state);
    if (useLocal) {
        try { localStorage.setItem('sudoku-state', body); } catch (_) {}
        return;
    }
    fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Sudoku': '1' },
        body,
        keepalive: !!leaving && body.length < 60000,
    }).catch(() => { dirty = true; });
}

// ------------------------------------------------------------------ puzzles

let worker = null, reqId = 0;
const pending = new Map();
try {
    worker = new Worker('worker.js');
    worker.onmessage = e => {
        const p = pending.get(e.data.id);
        pending.delete(e.data.id);
        if (p) e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.def);
    };
} catch (_) { worker = null; }

function ask(msg, local) {
    if (!worker) return new Promise((res, rej) => setTimeout(() => { try { res(local()); } catch (e) { rej(e); } }, 30));
    return new Promise((resolve, reject) => {
        const id = ++reqId;
        pending.set(id, { resolve, reject });
        worker.postMessage(Object.assign({ id }, msg));
    });
}
const generate = types => ask({ types }, () => E.generate({ types }));
const generateCase = () => ask({ kind: 'case' }, () => E.generateCase({}));

// Weighted random theme, avoiding the last few so variety stays high.
function chooseTypes() {
    const recent = state.recentTypes.slice(-3);
    const options = E.THEMES.filter(t => !recent.includes(t.types.join('+')));
    const total = options.reduce((s, t) => s + t.w, 0);
    let x = Math.random() * total;
    for (const t of options) if ((x -= t.w) < 0) return t.types;
    return options[0].types;
}
function noteTypes(types) {
    state.recentTypes.push(types.join('+'));
    state.recentTypes = state.recentTypes.slice(-6);
}

let filling = false;
async function fillQueue() {
    if (filling) return;
    filling = true;
    try {
        while (state.queue.length < 2) {
            const types = chooseTypes();
            noteTypes(types);
            state.queue.push(await generate(types));
            save();
        }
    } catch (e) {
        console.error(e);
    } finally {
        filling = false;
    }
}

const blank = () => new Array(81).fill(0);

async function startNew(given) {
    if (cur && cur.status === 'active') cur.status = 'skipped';
    let def = given || state.queue.shift();
    if (!def) {
        setBusy(true);
        const types = chooseTypes();
        noteTypes(types);
        try { def = await generate(types); } finally { setBusy(false); }
    }
    const rec = {
        id: 'p' + Date.now().toString(36), n: ++state.counter, def, status: 'active',
        createdAt: Date.now(), hints: 0, piece: choosePiece(),
        digits: blank(), corner: blank(), centre: blank(), colours: blank(),
    };
    state.puzzles[rec.id] = rec;
    state.order.unshift(rec.id);
    openPuzzle(rec);
    save();
    scheduleSync(500);
    fillQueue();
}

function openPuzzle(rec) {
    if (cur && cur !== rec && cur.status === 'active') cur.status = 'skipped';
    cur = rec;
    cur.status = 'active';
    state.currentId = rec.id;
    sel = new Set();
    lastSel = -1;
    pinnedDigit = 0;
    undoStack = [];
    redoStack = [];
    closeHint();
    $('title').textContent = rec.def.title;
    $('pnum').textContent = rec.def.case ? 'Room ' + rec.def.case.n + ' of ' + rec.def.case.of : '#' + rec.n;
    const rules = ['Normal sudoku rules apply.'].concat(rec.def.rules.filter(r => r !== E.RULES.classic));
    $('rules').innerHTML = (rec.def.room ? '<li class="roomIntro">' + esc(rec.def.room.intro) + '</li>' : '') +
        rules.map(r => '<li>' + esc(r) + '</li>').join('');
    renderCaseBar();
    render();
    renderPad();
    resetCelebrations();
    save();
}

function pruneSolved() {
    const solved = state.order.filter(id => state.puzzles[id] && state.puzzles[id].status === 'solved');
    solved.slice(KEEP_SOLVED_DEFS).forEach(id => {
        const p = state.puzzles[id];
        if (p.def) p.def = { title: p.def.title };
        delete p.digits; delete p.corner; delete p.centre; delete p.colours;
    });
}

// The classical piece that goes with a puzzle (see sound.js).
const piece = rec => {
    rec = rec || cur;
    return SFX.PIECES.find(p => p.id === rec.piece) || SFX.pieceFor(rec.id);
};
// A piece for a new puzzle, avoiding the ones heard most recently. Stored
// on the puzzle, so it syncs and both devices play the same piece.
function choosePiece() {
    const recent = state.order.slice(0, 12).map(id => state.puzzles[id]).filter(Boolean).map(r => piece(r).id);
    const options = SFX.PIECES.filter(p => !recent.includes(p.id));
    return (options.length ? options : SFX.PIECES)[Math.floor(Math.random() * (options.length || SFX.PIECES.length))].id;
}
const pieceName = rec => { const p = piece(rec); return '♪ ' + p.title + ', ' + p.by; };

// Replaying a finished puzzle's tune. Any number of buttons can show the
// same tune: each says "■ Stop" while its puzzle's tune plays.
let tuneRec = null;
const tuneButtons = new Set();

function syncTuneButtons() {
    tuneButtons.forEach(b => {
        // Forget buttons that have left the page (a button may be set up
        // just before it's added, so only once it has been seen on it).
        if (!b.isConnected && b.seen) return tuneButtons.delete(b);
        if (b.isConnected) b.seen = true;
        b.textContent = SFX.isPlaying() && tuneRec === b.tuneRec ? b.tuneStop : b.tuneLabel;
    });
}

function playTune(rec, delay, quiet) {
    if (!state.settings.sound) {
        if (!quiet) toast('Sound is off: tap 🔊 at the top to turn it on.');
        return;
    }
    SFX.finale(piece(rec), delay || 0, () => { tuneRec = null; syncTuneButtons(); });
    tuneRec = rec;
    syncTuneButtons();
}

function tuneButton(btn, rec, label, stopLabel) {
    btn.tuneRec = rec;
    btn.tuneLabel = label || '▶ Play its tune';
    btn.tuneStop = stopLabel || '■ Stop';
    btn.onclick = e => {
        e.stopPropagation();
        if (SFX.isPlaying() && tuneRec === rec) SFX.stop();
        else playTune(rec);
    };
    tuneButtons.add(btn);
    syncTuneButtons();
    return btn;
}

// ------------------------------------------------------------------ grid helpers

const givens = () => cur.def.givens;
const isGiven = i => !!cur.def.givens[i];
const digitAt = i => cur.def.givens[i] || cur.digits[i];
const allDigits = () => cur.def.givens.map((g, i) => g || cur.digits[i]);

function clashes() {
    const out = new Set();
    for (const h of E.HOUSES) {
        const seen = {};
        for (const i of h) {
            const d = digitAt(i);
            if (!d) continue;
            (seen[d] = seen[d] || []).push(i);
        }
        Object.values(seen).forEach(list => { if (list.length > 1) list.forEach(i => out.add(i)); });
    }
    return out;
}

// ------------------------------------------------------------------ drawing

const cx = i => E.colOf(i) * 100 + 50;
const cy = i => E.rowOf(i) * 100 + 50;

function cageOutline(cells) {
    const set = new Set(cells), inset = 8, segs = [];
    const has = (r, c) => r >= 0 && r < 9 && c >= 0 && c < 9 && set.has(r * 9 + c);
    for (const i of cells) {
        const r = E.rowOf(i), c = E.colOf(i), x = c * 100, y = r * 100;
        const end = (along, diag, base, sign) => (along ? (diag ? base - sign * inset : base) : base + sign * inset);
        if (!has(r - 1, c)) segs.push([end(has(r, c - 1), has(r - 1, c - 1), x, 1), y + inset, end(has(r, c + 1), has(r - 1, c + 1), x + 100, -1), y + inset]);
        if (!has(r + 1, c)) segs.push([end(has(r, c - 1), has(r + 1, c - 1), x, 1), y + 100 - inset, end(has(r, c + 1), has(r + 1, c + 1), x + 100, -1), y + 100 - inset]);
        if (!has(r, c - 1)) segs.push([x + inset, end(has(r - 1, c), has(r - 1, c - 1), y, 1), x + inset, end(has(r + 1, c), has(r + 1, c - 1), y + 100, -1)]);
        if (!has(r, c + 1)) segs.push([x + 100 - inset, end(has(r - 1, c), has(r - 1, c + 1), y, 1), x + 100 - inset, end(has(r + 1, c), has(r + 1, c + 1), y + 100, -1)]);
    }
    return segs.map(s => `<line class="cage" x1="${s[0]}" y1="${s[1]}" x2="${s[2]}" y2="${s[3]}"/>`).join('');
}

function line(cells, cls, width, colour) {
    const pts = cells.map(i => cx(i) + ',' + cy(i)).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
}

function edgeMid(a, b) {
    return [(cx(a) + cx(b)) / 2, (cy(a) + cy(b)) / 2];
}

// An escape room's unnamed rule is drawn in the story's own style (copper
// pipes, silver star trails), so its colour doesn't give it away.
const mysteryStyle = def => (def.case && def.case.lineStyle === 'star' ? ['var(--trail-dark)', 'var(--trail)'] : ['var(--pipe-dark)', 'var(--pipe)']);
const pipeLine = (p, def) => {
    const [dark, light] = mysteryStyle(def);
    const pts = p.map(i => cx(i) + ',' + cy(i)).join(' ');
    const pl = (w, c, o) => `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity="${o}"/>`;
    return pl(17, dark, 0.75) + pl(5, light, 0.85);
};

function drawConstraints(def, rec) {
    let s = '';
    // Odd/even shapes sit underneath everything else in the cell.
    (def.odds || []).forEach(i => (s += `<circle class="pc-parity" cx="${cx(i)}" cy="${cy(i)}" r="40"/>`));
    (def.evens || []).forEach(i => (s += `<rect class="pc-parity" x="${cx(i) - 38}" y="${cy(i) - 38}" width="76" height="76" rx="6"/>`));
    (def.thermos || []).forEach(p => {
        if (def.mystery === 'thermo') {
            const [dark, light] = mysteryStyle(def);
            s += pipeLine(p, def) + `<circle cx="${cx(p[0])}" cy="${cy(p[0])}" r="26" fill="none" stroke="${dark}" stroke-width="7" opacity="0.8"/>` +
                `<circle cx="${cx(p[0])}" cy="${cy(p[0])}" r="26" fill="none" stroke="${light}" stroke-width="2.5"/>`;
            return;
        }
        s += line(p, '', 26, 'var(--thermo)');
        s += `<circle cx="${cx(p[0])}" cy="${cy(p[0])}" r="34" fill="var(--thermo)"/>`;
    });
    (def.whispers || []).forEach(p => (s += def.mystery === 'whispers' ? pipeLine(p, def) : line(p, '', 18, 'var(--whisper)')));
    (def.renbans || []).forEach(p => (s += def.mystery === 'renban' ? pipeLine(p, def) : line(p, '', 18, 'var(--renban)')));
    (def.dutch || []).forEach(p => (s += def.mystery === 'dutch' ? pipeLine(p, def) : line(p, '', 18, 'var(--dutch)')));
    (def.palindromes || []).forEach(p => (s += def.mystery === 'palindrome' ? pipeLine(p, def) : line(p, '', 18, 'var(--palin)')));
    (def.arrows || []).forEach(a => {
        const first = a.path[0], dx = cx(first) - cx(a.circle), dy = cy(first) - cy(a.circle);
        const len = Math.hypot(dx, dy), sx = cx(a.circle) + (dx / len) * 38, sy = cy(a.circle) + (dy / len) * 38;
        const pts = [sx + ',' + sy].concat(a.path.map(i => cx(i) + ',' + cy(i))).join(' ');
        s += `<polyline points="${pts}" fill="none" stroke="var(--arrow)" stroke-width="4" stroke-linejoin="round"/>`;
        const last = a.path[a.path.length - 1];
        const prevX = a.path.length > 1 ? cx(a.path[a.path.length - 2]) : sx, prevY = a.path.length > 1 ? cy(a.path[a.path.length - 2]) : sy;
        const ang = Math.atan2(cy(last) - prevY, cx(last) - prevX);
        [-0.55, 0.55].forEach(o => {
            s += `<line x1="${cx(last)}" y1="${cy(last)}" x2="${cx(last) - 22 * Math.cos(ang + o)}" y2="${cy(last) - 22 * Math.sin(ang + o)}" stroke="var(--arrow)" stroke-width="4" stroke-linecap="round"/>`;
        });
        s += `<circle cx="${cx(a.circle)}" cy="${cy(a.circle)}" r="38" fill="var(--cell)" stroke="var(--arrow)" stroke-width="4"/>`;
    });
    const hidden = def.lockedCage != null && !(rec && rec.unlocked) ? def.cages[def.lockedCage] : null;
    (def.cages || []).forEach(c => {
        s += cageOutline(c.cells);
        const tl = Math.min(...c.cells), x = E.colOf(tl) * 100 + 5, y = E.rowOf(tl) * 100 + 4;
        if (c === hidden) {
            s += `<rect class="cagesumbg" x="${x}" y="${y}" width="30" height="26"/><text class="cagesum lockSum" x="${x + 2}" y="${y + 20}">🔑</text>`;
            return;
        }
        const w = String(c.sum).length * 12 + 6;
        s += `<rect class="cagesumbg" x="${x}" y="${y}" width="${w}" height="24"/><text class="cagesum" x="${x + 3}" y="${y + 20}">${c.sum}</text>`;
    });
    return s;
}

function drawEdges(def) {
    let s = '';
    (def.dots || []).forEach(d => {
        const [x, y] = edgeMid(d.a, d.b);
        s += d.t === 'w'
            ? `<circle cx="${x}" cy="${y}" r="9.5" fill="#ffffff" stroke="#1d1d1f" stroke-width="3"/>`
            : `<circle cx="${x}" cy="${y}" r="9.5" fill="#000000" stroke="var(--line)" stroke-width="2.5"/>`;
    });
    (def.xv || []).forEach(d => {
        const [x, y] = edgeMid(d.a, d.b);
        s += `<rect x="${x - 13}" y="${y - 13}" width="26" height="26" rx="5" fill="var(--cell)"/><text class="edgeText" x="${x}" y="${y + 1}">${d.t.toUpperCase()}</text>`;
    });
    return s;
}

// Escape-room cells: 🔑 keys and the padlock's dial symbols. While playing,
// a cell gets a coloured frame and a faint watermark of its symbol behind
// everything, so corner and centre marks stay readable on top. The small
// corner badge is only for still pictures, which have no pencil marks.
function markTints(def) {
    return (def.marks || []).map(m => {
        // Class names are prefixed: the exit door's .dial buttons have a fixed
        // width, which would otherwise squash an SVG rect with class "dial".
        const x = E.colOf(m.cell) * 100, y = E.rowOf(m.cell) * 100, kind = m.kind === 'key' ? 'key' : 'dial';
        return `<rect x="${x}" y="${y}" width="100" height="100" fill="var(--${kind}cell)"/>` +
            `<text class="markMark mk-${kind}" x="${x + 50}" y="${y + 54}">${m.icon}</text>` +
            `<rect class="markFrame mk-${kind}" x="${x + 5}" y="${y + 5}" width="90" height="90" rx="10"/>`;
    }).join('');
}
function markIcons(def) {
    return (def.marks || []).map(m => `<text class="markIcon mk-${m.kind}" x="${E.colOf(m.cell) * 100 + 80}" y="${E.rowOf(m.cell) * 100 + 80}">${m.icon}</text>`).join('');
}

function gridLines() {
    let grid = '';
    for (let k = 1; k < 9; k++) {
        if (k % 3) grid += `<line class="thin" x1="${k * 100}" y1="0" x2="${k * 100}" y2="900"/><line class="thin" x1="0" y1="${k * 100}" x2="900" y2="${k * 100}"/>`;
    }
    for (let k = 0; k <= 9; k += 3) grid += `<line class="thick" x1="${k * 100}" y1="-2.5" x2="${k * 100}" y2="902.5"/><line class="thick" x1="-2.5" y1="${k * 100}" x2="902.5" y2="${k * 100}"/>`;
    return grid;
}

// A still picture of a puzzle: the givens, plus the rest of the solution
// when showSolution is set.
function drawStill(def, showSolution) {
    let fg = '';
    for (let i = 0; i < 81; i++) {
        const d = def.givens[i] || (showSolution ? def.solution[i] : 0);
        if (d) fg += `<text class="digit ${def.givens[i] ? 'given' : 'user'}" x="${E.colOf(i) * 100 + 50}" y="${E.rowOf(i) * 100 + 53}">${d}</text>`;
    }
    return '<rect x="0" y="0" width="900" height="900" class="cellbg"/>' + markTints(def) + drawConstraints(def, { unlocked: true }) + gridLines() + drawEdges(def) + fg + markIcons(def);
}

function render() {
    if (!cur) return;
    const def = cur.def, st = state.settings;
    const digits = allDigits();
    const clash = st.showConflicts ? clashes() : new Set();
    const sumCells = new Set((def.cages || []).map(c => Math.min(...c.cells)));
    let sameDigit = 0;
    if (st.highlightSame && sel.size === 1 && !pinnedDigit) sameDigit = digits[[...sel][0]];

    let bg = '<rect x="0" y="0" width="900" height="900" class="cellbg"/>' + markTints(def);
    let fg = '';
    for (let i = 0; i < 81; i++) {
        const x = E.colOf(i) * 100, y = E.rowOf(i) * 100;
        if (cur.colours[i]) bg += `<rect x="${x}" y="${y}" width="100" height="100" fill="${COLOURS[cur.colours[i] - 1]}" opacity="0.55"/>`;
        if (clash.has(i)) bg += `<rect x="${x}" y="${y}" width="100" height="100" fill="var(--clash)"/>`;
        if (pinnedDigit && digits[i] === pinnedDigit) bg += `<rect x="${x}" y="${y}" width="100" height="100" fill="var(--pinned)"/><rect x="${x + 5}" y="${y + 5}" width="90" height="90" rx="10" fill="none" stroke="var(--user)" stroke-width="5"/>`;
        if (sameDigit && digits[i] === sameDigit && !sel.has(i)) bg +=`<rect x="${x}" y="${y}" width="100" height="100" fill="var(--same)"/>`;
        if (hintView && hintView.helperCells && hintView.helperCells.includes(i)) bg += `<rect x="${x}" y="${y}" width="100" height="100" fill="var(--helper)"/>`;
        if (sel.has(i)) bg += `<rect x="${x}" y="${y}" width="100" height="100" fill="var(--select)"/>`;
        if (hintView && hintView.target === i) bg += `<rect class="pulse" x="${x + 4}" y="${y + 4}" width="92" height="92" rx="8" fill="var(--hint)" stroke="#34c759" stroke-width="5"/>`;
        if (hintView && hintView.mistakes && hintView.mistakes.includes(i)) bg += `<rect class="pulse" x="${x + 4}" y="${y + 4}" width="92" height="92" rx="8" fill="none" stroke="var(--wrong)" stroke-width="6"/>`;

        const d = digits[i];
        if (d) {
            const wrong = !isGiven(i) && st.showMistakes && d !== def.solution[i];
            fg += `<text class="digit ${isGiven(i) ? 'given' : 'user'}${wrong ? ' wrong' : ''}" x="${x + 50}" y="${y + 53}">${d}</text>`;
        } else {
            const corner = E.DIGITS[cur.corner[i]];
            const pos = sumCells.has(i) ? CAGE_CORNER_POS : CORNER_POS;
            const cls = pos === CAGE_CORNER_POS ? 'corner cg' : 'corner';
            corner.forEach((m, k) => {
                const [px, py] = pos[k];
                fg += `<text class="${cls}" x="${x + px}" y="${y + py}">${m}</text>`;
            });
            const centre = E.DIGITS[cur.centre[i]].join('');
            if (centre) {
                const size = centre.length <= 3 ? 28 : centre.length <= 5 ? 22 : 16;
                fg += `<text class="centre" x="${x + 50}" y="${y + 52}" font-size="${size}">${centre}</text>`;
            }
        }
    }
    board.innerHTML = bg + drawConstraints(def, cur) + gridLines() + drawEdges(def) + fg;
    updateButtons();
    renderCagePanel();
}

// ------------------------------------------------------------------ cage combinations

// Every set of k different digits from `from` (ascending) adding up to sum.
function combos(k, sum, from) {
    const out = [], pick = [];
    (function go(start, left, n) {
        if (!n) { if (!left) out.push(pick.slice()); return; }
        for (let i = start; i < from.length && from[i] <= left; i++) {
            pick.push(from[i]);
            go(i + 1, left - from[i], n - 1);
            pick.pop();
        }
    })(0, sum, k);
    return out;
}

// Every combination of digits (as sorted multisets) that the open cells
// can hold to add up to sum. Two open cells may share a digit only when
// `distinct` is off and they don't see each other (arrow lines), and an open
// cell never repeats a placed digit it sees.
function lineCombos(open, placedCells, sum, digits, distinct) {
    const sees = (a, b) => distinct || seesCell(a, b);
    const out = new Set(), pick = [];
    (function go(n, left) {
        if (n === open.length) { if (!left) out.add(pick.slice().sort((a, b) => a - b).join('')); return; }
        for (let d = 1; d <= 9 && d <= left; d++) {
            if (placedCells.some(j => digits[j] === d && sees(open[n], j))) continue;
            if (pick.some((e, m) => e === d && sees(open[n], open[m]))) continue;
            pick.push(d);
            go(n + 1, left - d);
            pick.pop();
        }
    })(0, sum);
    return [...out].map(t => t.split('').map(Number));
}
const seesCell = (a, b) => ((a / 9) | 0) === ((b / 9) | 0) || a % 9 === b % 9 ||
    (((a / 27) | 0) === ((b / 27) | 0) && (((a % 9) / 3) | 0) === (((b % 9) / 3) | 0));

// The clues on a cell that the panel lists combinations for: killer cages,
// X/V pairs and arrows. `key` names its struck-out marks (a cage keeps its
// plain index, so older saved marks still apply).
function panelClues(i) {
    const def = cur.def, out = [];
    (def.cages || []).forEach((c, k) => c.cells.includes(i) && out.push({ kind: 'cage', key: k, cells: c.cells, sum: c.sum, cage: c }));
    (def.xv || []).forEach((x, k) => (x.a === i || x.b === i) &&
        out.push({ kind: 'xv', key: 'x' + k, cells: [x.a, x.b], sum: x.t === 'x' ? 10 : 5, t: x.t }));
    (def.arrows || []).forEach((a, k) => (a.circle === i || a.path.includes(i)) &&
        out.push({ kind: 'arrow', key: 'a' + k, cells: a.path, circle: a.circle }));
    return out;
}

// The clues on the cell most recently selected.
function focusClues() {
    if (!sel.size) return [];
    return panelClues(sel.has(lastSel) ? lastSel : [...sel][0]);
}
const hasPanel = def => !!((def.cages && def.cages.length) || (def.xv && def.xv.length) || (def.arrows && def.arrows.length));

function renderCagePanel() {
    const panel = $('cagePanel');
    panel.hidden = !hasPanel(cur.def);
    if (panel.hidden) return;
    const clues = focusClues();
    const lockedC = clues.find(c => c.kind === 'cage' && isLockedCage(c.cage));
    if (lockedC) return renderLockPanel(panel, lockedC.cage);
    if (!clues.length) {
        const what = [cur.def.cages && cur.def.cages.length && 'a cage', cur.def.xv && cur.def.xv.length && 'an X or V',
            cur.def.arrows && cur.def.arrows.length && 'an arrow'].filter(Boolean);
        const list = what.length > 1 ? what.slice(0, -1).join(', ') + ' or ' + what[what.length - 1] : what[0];
        panel.innerHTML = `<h3>Combinations</h3><p class="cageHelp">Select a cell in ${list} to see which digits can make its total.</p>`;
        return;
    }
    panel.innerHTML = clues.map(clueSection).join('');
}

function clueSection(c) {
    const digits = allDigits();
    let head, distinct = true, sum = c.sum;
    if (c.kind === 'cage') head = `Cage ${c.sum} · ${c.cells.length} cells`;
    else if (c.kind === 'xv') head = `${c.t.toUpperCase()} · adds up to ${c.sum}`;
    else {
        sum = digits[c.circle];
        if (!sum) return `<section class="clue"><h3>Arrow · ${c.cells.length} ${c.cells.length === 1 ? 'cell' : 'cells'}</h3>
            <p class="cageHelp">Place a digit in the circle to see what its line can hold.</p></section>`;
        head = `Arrow · line adds up to ${sum}`;
        distinct = false;
    }
    let html = `<section class="clue" data-clue="${c.key}"><h3>${head}</h3>`;
    const placedCells = c.cells.filter(i => digits[i]), openCells = c.cells.filter(i => !digits[i]);
    const placed = placedCells.map(i => digits[i]);
    const open = openCells.length;
    const left = sum - placed.reduce((a, b) => a + b, 0);
    const what = c.kind === 'cage' ? 'cage' : c.kind === 'xv' ? 'pair' : 'line';
    const label = c.kind === 'cage' ? 'Cage' : c.kind === 'xv' ? c.t.toUpperCase() : 'Arrow';
    if (placed.length && open) {
        html += `<p class="cageHelp">${placed.join(' + ')} placed, so the other ${open === 1 ? 'cell makes' : open + ' cells make'} ${left}.</p>`;
    }
    const clash = placedCells.some((a, m) => placedCells.some((b, n) => n > m && digits[a] === digits[b] && (distinct || seesCell(a, b))));
    if (clash) {
        html += `<p class="cageWarn">A digit repeats in this ${what}.</p>`;
    } else if (!open) {
        html += left ? `<p class="cageWarn">These add up to ${sum - left}, not ${sum}.</p>` : `<p class="cageDone">${label} complete ✓</p>`;
    } else {
        const list = distinct
            ? combos(open, left, [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d => !placed.includes(d)))
            : lineCombos(openCells, placedCells, left, digits, false);
        if (!list.length) {
            html += `<p class="cageWarn">No digits make ${left} here. Check the digits in this ${what}.</p>`;
        } else {
            // Struck combinations are remembered by the whole clue's digits,
            // so they stay struck as digits get placed.
            const marks = cageMarks(c.key);
            const key = l => l.concat(placed).sort((a, b) => a - b).join('');
            const struck = l => marks.combos.includes(key(l)) ||
                (l.some(d => marks.digits.includes(d)) && !marks.keep.includes(key(l)));
            const live = list.filter(l => !struck(l)), dead = list.filter(struck);
            html += '<div class="combos">' +
                live.map(l => `<button class="combo" data-combo="${key(l)}" title="Strike out">${l.join('')}</button>`).join('') +
                dead.map(l => `<button class="combo struck" data-combo="${key(l)}" title="Bring back">${l.join('')}</button>`).join('') + '</div>';
            const from = [1, 2, 3, 4, 5, 6, 7, 8, 9];
            if (list.length > 1) {
                const inCombos = from.filter(d => list.some(l => l.includes(d)));
                html += '<div class="ruleOut"><span>Rule out:</span>' + inCombos.map(d =>
                    `<button data-out="${d}" class="${marks.digits.includes(d) ? 'on' : ''}" title="Strike every combination with a ${d}">${d}</button>`).join('') + '</div>';
            }
            if (!live.length) {
                html += '<p class="cageWarn">Every combination is struck out.</p>';
            } else {
                const inList = from.filter(d => list.some(l => l.includes(d)) || !placed.includes(d));
                const always = inList.filter(d => live.every(l => l.includes(d)));
                const never = inList.filter(d => !live.some(l => l.includes(d)));
                if (live.length > 1 && always.length) html += `<p class="cageNote">In every combination: <b>${always.join('')}</b></p>`;
                if (never.length) html += `<p class="cageNote">Never: <b>${never.join('')}</b></p>`;
            }
            if (dead.length) html += '<button class="cageReset" data-reset="1">Show all again</button>';
        }
    }
    return html + '</section>';
}

// What you've struck out in a clue's combinations: whole combinations, and
// digits whose combinations are all struck. Kept on the puzzle, so it syncs.
function cageMarks(k) {
    cur.cageMarks = cur.cageMarks || {};
    const m = cur.cageMarks[k] || {};
    return { combos: m.combos || [], digits: m.digits || [], keep: m.keep || [] };
}
function setCageMarks(k, m) {
    cur.cageMarks = cur.cageMarks || {};
    if (!m.combos.length && !m.digits.length) delete cur.cageMarks[k];
    else cur.cageMarks[k] = m;
    touch();
    save();
    renderCagePanel();
}
$('cagePanel').addEventListener('click', e => {
    const b = e.target.closest('button'), sec = e.target.closest('[data-clue]');
    if (!b || !sec || !cur) return;
    const c = focusClues().find(c => String(c.key) === sec.dataset.clue);
    if (!c || (c.kind === 'cage' && isLockedCage(c.cage))) return;
    const k = c.key, m = cageMarks(k);
    const combo = b.dataset.combo, without = (arr, v) => arr.filter(x => x !== v);
    if (combo && b.classList.contains('struck')) {
        // Bring back just this one: un-strike it, and if a ruled-out digit
        // struck it, keep it as an exception.
        const byDigit = m.digits.some(d => combo.includes(String(d)));
        setCageMarks(k, { combos: without(m.combos, combo), digits: m.digits, keep: byDigit ? m.keep.concat(combo) : m.keep });
    } else if (combo) {
        setCageMarks(k, { combos: m.combos.concat(combo), digits: m.digits, keep: without(m.keep, combo) });
    } else if (b.dataset.out) {
        const d = +b.dataset.out, off = m.digits.includes(d);
        // Ruling a digit in or out again starts its combinations afresh.
        setCageMarks(k, { combos: m.combos, digits: off ? without(m.digits, d) : m.digits.concat(d),
            keep: m.keep.filter(c => !c.includes(String(d))) });
    } else if (b.dataset.reset) {
        setCageMarks(k, { combos: [], digits: [], keep: [] });
    }
});

// Tries a number on the Furnace's locked cage. True when it fits.
function tryUnlock(text) {
    const c = cur.def.cages[cur.def.lockedCage], v = parseInt(text, 10);
    if (v !== c.sum) {
        toast(Number.isNaN(v) ? 'Type a number first.' : 'The key won\'t turn. It isn\'t ' + v + '.');
        return false;
    }
    cur.unlocked = true;
    touch();
    save();
    render();
    renderCaseBar();
    celebrate([{ kind: 'cage', cells: c.cells }]);
    toast('🔑 Click! The cage total is ' + c.sum + '.');
    return true;
}

const isLockedCage = c => cur.def.lockedCage != null && !cur.unlocked && cur.def.cages[cur.def.lockedCage] === c;

function renderLockPanel(panel, c) {
    panel.innerHTML = `<h3>🔑 Locked cage · ${c.cells.length} cells</h3>
        <p class="cageHelp">Its total is hidden behind a keyhole. Got a number that might fit?</p>
        <div class="lockTry"><input id="lockInput" type="text" inputmode="numeric" maxlength="2" placeholder="?" autocomplete="off"><button id="lockBtn" class="accent">Try the key</button></div>`;
    const tryKey = () => { if (!tryUnlock($('lockInput').value)) $('lockInput').value = ''; };
    $('lockBtn').onclick = tryKey;
    $('lockInput').onkeydown = e => { if (e.key === 'Enter') tryKey(); };
}

function renderPad() {
    const pad = $('pad');
    const digits = cur ? allDigits() : [];
    let html = '';
    for (let d = 1; d <= 9; d++) {
        const count = digits.filter(x => x === d).length;
        let inner = d;
        if (mode === 'corner') inner = `<span style="position:absolute;left:7px;top:4px">${d}</span>`;
        if (mode === 'centre') inner = `<span style="font-size:14px">${d}</span>`;
        if (mode === 'colour') inner = `<span class="sw" style="background:${COLOURS[d - 1]}"></span>`;
        const done = mode === 'normal' && count >= 9 ? ' style="opacity:0.35"' : '';
        html += `<button data-d="${d}" class="${mode === 'corner' || mode === 'centre' ? 'mark' : ''}"${done} title="${count}/9 placed">${inner}</button>`;
    }
    pad.innerHTML = html;
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
}

function updateButtons() {
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
}

function setBusy(on, text) {
    busy = on;
    $('busy').hidden = !on;
    $('busyText').textContent = text || 'Making a new puzzle…';
}

function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

// ------------------------------------------------------------------ editing

const snapshot = () => ({ d: cur.digits.slice(), k: cur.corner.slice(), m: cur.centre.slice(), c: cur.colours.slice() });
const sameSnap = (a, b) => ['d', 'k', 'm', 'c'].every(key => a[key].every((v, i) => v === b[key][i]));
function restore(s) { cur.digits = s.d.slice(); cur.corner = s.k.slice(); cur.centre = s.m.slice(); cur.colours = s.c.slice(); }

function commit(before) {
    if (sameSnap(before, snapshot())) return;
    undoStack.push(before);
    if (undoStack.length > 400) undoStack.shift();
    redoStack = [];
    afterChange();
}

function afterChange() {
    if (hintView && hintView.target != null && digitAt(hintView.target)) closeHint();
    if (hintView && hintView.mistakes) closeHint();
    render();
    renderPad();
    touch();
    save();
    checkCelebrations();
    checkWin();
}

function enter(d, m) {
    if (!cur || cur.status !== 'active' || !sel.size) return;
    m = m || mode;
    const before = snapshot();
    const cells = [...sel];
    if (m === 'colour') {
        const all = cells.every(i => cur.colours[i] === d);
        cells.forEach(i => (cur.colours[i] = all ? 0 : d));
        return commit(before);
    }
    const open = cells.filter(i => !isGiven(i));
    if (!open.length) return;
    if (m === 'normal') {
        const all = open.every(i => cur.digits[i] === d);
        open.forEach(i => (cur.digits[i] = all ? 0 : d));
        if (!all) SFX.place(piece(), cur.digits.filter(Boolean).length - 1, d, state.settings.soundStyle);
        if (!all && state.settings.autoClean) {
            open.forEach(i => E.PEERS[i].forEach(p => {
                cur.corner[p] &= ~E.bit(d);
                cur.centre[p] &= ~E.bit(d);
            }));
        }
    } else {
        const arr = m === 'corner' ? cur.corner : cur.centre;
        const empty = open.filter(i => !cur.digits[i]);
        if (!empty.length) return;
        const all = empty.every(i => arr[i] & E.bit(d));
        empty.forEach(i => (arr[i] = all ? arr[i] & ~E.bit(d) : arr[i] | E.bit(d)));
    }
    commit(before);
}

function clearSelected() {
    if (!cur || cur.status !== 'active' || !sel.size) return;
    const before = snapshot();
    const cells = [...sel], open = cells.filter(i => !isGiven(i));
    if (mode === 'colour') cells.forEach(i => (cur.colours[i] = 0));
    else if (open.some(i => cur.digits[i])) open.forEach(i => (cur.digits[i] = 0));
    else if (mode === 'corner') open.forEach(i => (cur.corner[i] = 0));
    else if (mode === 'centre') open.forEach(i => (cur.centre[i] = 0));
    else if (open.some(i => cur.corner[i] || cur.centre[i])) open.forEach(i => (cur.corner[i] = cur.centre[i] = 0));
    else cells.forEach(i => (cur.colours[i] = 0));
    commit(before);
}

function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    afterChange();
}
function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    afterChange();
}

function setMode(m) {
    mode = m;
    renderPad();
}

// ------------------------------------------------------------------ hints

function closeHint() {
    hintView = null;
    $('hintBar').hidden = true;
    if (cur) render();
}

function showHint(html, buttons) {
    $('hintText').innerHTML = html;
    const box = $('hintBtns');
    box.innerHTML = '';
    buttons.forEach(([label, fn, accent]) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (accent) b.className = 'accent';
        b.onclick = fn;
        box.appendChild(b);
    });
    $('hintBar').hidden = false;
}

function doHint() {
    if (!cur || cur.status !== 'active') return;
    const h = E.hint(cur.def, allDigits());
    h.text = caseSafe(h.text);
    (h.helpers || []).forEach(x => (x.text = caseSafe(x.text)));
    cur.hints++;
    touch();
    save();
    if (h.kind === 'mistake') {
        hintView = {};
        showHint('<p>' + h.text + '</p>', [
            ['Show me', () => { hintView = { mistakes: h.cells }; render(); }, true],
            ['Close', closeHint],
        ]);
        render();
        return;
    }
    if (h.kind === 'done') { showHint('<p>' + h.text + '</p>', [['Close', closeHint]]); return; }
    const fill = () => {
        sel = new Set([h.cell]);
        lastSel = h.cell;
        closeHint();
        enter(h.digit, 'normal');
    };
    hintView = { target: h.cell };
    sel = new Set([h.cell]);
    lastSel = h.cell;
    render();
    showHint('<p>You can place a digit in the highlighted cell. Can you see which one?</p>', [
        ['Why?', () => {
            const helperCells = [];
            h.helpers.forEach(x => helperCells.push(...x.cells));
            h.cells.forEach(i => helperCells.push(i));
            hintView = { target: h.cell, helperCells };
            render();
            const helpers = h.helpers.map(x => '<li>' + x.text.replace(/\n/g, '<br>') + '</li>').join('');
            showHint('<p><b>' + h.text + '</b></p>' + (helpers ? '<ul class="reasons">' + helpers + '</ul>' : ''), [
                ['Fill it in', fill, true],
                ['Close', closeHint],
            ]);
        }, true],
        ['Fill it in', fill],
        ['Close', closeHint],
    ]);
}

// In an escape room, hints mustn't name the locked cage's total or the
// pipes' rule.
function caseSafe(text) {
    if (!text) return text;
    const d = cur.def;
    if (d.lockedCage != null && !cur.unlocked) {
        const c = d.cages[d.lockedCage], at = ' cage at ' + E.cellName(Math.min(...c.cells));
        text = text.split('the ' + c.sum + at).join('the 🔑' + at);
    }
    if (d.mystery) text = text.replace(/the green line|the purple line|the thermometer|the orange line|the palindrome line/g, 'the ' + ((d.case && d.case.line) || 'copper pipe'));
    return text;
}

function checkGrid() {
    if (!cur) return;
    const sol = cur.def.solution;
    const wrong = cur.digits.filter((d, i) => d && d !== sol[i]).length;
    toast(wrong ? `${wrong} digit${wrong > 1 ? 's are' : ' is'} wrong` : 'Everything so far is correct 👍');
}

// ------------------------------------------------------------------ winning

function checkWin() {
    if (!cur || cur.status !== 'active') return;
    const sol = cur.def.solution;
    for (let i = 0; i < 81; i++) if (digitAt(i) !== sol[i]) return;
    cur.status = 'solved';
    cur.solvedAt = Date.now();
    touch();
    sel = new Set();
    closeHint();
    render();
    pruneSolved();
    save();
    const rec = cur;
    fillQueue();
    playTune(rec, 0.7, true);
    setTimeout(() => {
        if (rec.def.case) return caseRoomSolved(rec);
        $('winText').textContent = `${rec.def.title} #${rec.n}`;
        $('winPiece').textContent = pieceName(rec);
        tuneButton($('winTune'), rec, '▶ Play it again');
        $('winPanel').hidden = false;
    }, 900);
}

// ------------------------------------------------------------------ panels

function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Escape rooms expanded in the list (this visit only).
const openCases = new Set();

function showList() {
    const recs = state.order.map(id => state.puzzles[id]).filter(Boolean);
    const going = recs.filter(p => p.status !== 'solved' && !p.def.case);
    const solved = recs.filter(p => p.status === 'solved' && !p.def.case);
    const filled = p => p.def.givens.filter((g, i) => g || p.digits[i]).length;
    const thumb = p => p.def.solution ? `<svg class="thumb" viewBox="-6 -6 912 912">${drawStill(p.def, true)}</svg>` : '';
    // A solved puzzle: tap the row to open it, ▶ to hear its tune.
    const solvedRow = (p, label) => p.def.solution ? `
        <div class="item" data-view="${p.id}">${thumb(p)}<div class="grow"><div class="name">${esc(p.def.title)} <span class="muted">${label}</span></div>
        <div class="meta">Solved ${fmtDate(p.solvedAt)} · ♪ ${esc(piece(p).title)}</div></div>
        <button class="playBtn" data-tune-for="${p.id}" title="Play its tune">▶</button></div>`
        : `<div class="item"><div class="grow"><div class="name">${esc(p.def.title)} <span class="muted">${label}</span></div>
        <div class="meta">Solved ${fmtDate(p.solvedAt)}</div></div></div>`;
    let html = '';

    const cases = caseIds().map(caseInfo).filter(c => c.complete);
    if (cases.length) {
        html += '<div class="group">Escape rooms</div>' + cases.map((c, k) => {
            const id = c.info.id, isOpen = openCases.has(id);
            const meta = c.escaped ? 'Escaped ' + fmtDate(c.escaped)
                : c.open ? `Room ${c.open.def.case.n} of ${c.info.of}: ${esc(c.open.def.room.name)}` : 'At ' + exitName(c.info).replace(/^The /, 'the ');
            const btn = c.escaped ? '<span class="muted">🎉</span>' : `<button data-case="${id}">${c.open ? 'Resume' : 'Open the door'}</button>`;
            let out = `<div class="item caseRow" data-expand="${id}"><span class="chev">${isOpen ? '▾' : '▸'}</span>
                <div class="grow"><div class="name">🗝️ ${esc(c.info.title)} <span class="muted">#${cases.length - k}</span></div><div class="meta">${meta}</div></div>${btn}</div>`;
            if (isOpen) {
                out += '<div class="caseRooms">' + c.rooms.map(p => {
                    const label = 'Room ' + p.def.case.n;
                    if (p.status === 'solved') return solvedRow(p, label);
                    if (p.status === 'locked') return `<div class="item locked"><div class="grow"><div class="name">🔒 ${esc(p.def.title)} <span class="muted">${label}</span></div><div class="meta">Not reached yet</div></div></div>`;
                    return `<div class="item"><div class="grow"><div class="name">${esc(p.def.title)} <span class="muted">${label}</span></div>
                        <div class="meta">${filled(p)}/81 filled</div></div>${p === cur ? '<span class="muted">Playing</span>' : `<button data-resume="${p.id}">Resume</button>`}</div>`;
                }).join('') + '</div>';
            }
            return out;
        }).join('');
    }

    html += '<div class="group">In progress</div>';
    html += going.length ? going.map(p => `
        <div class="item${p === cur ? ' current' : ''}">
          <div class="grow"><div class="name">${esc(p.def.title)} <span class="muted">#${p.n}</span></div>
          <div class="meta">${filled(p)}/81 filled${p.status === 'skipped' ? ' · set aside' : ''}</div></div>
          ${p === cur ? '<span class="muted">Playing</span>' : `<button data-resume="${p.id}">Resume</button>`}
          <button class="delBtn" data-delete="${p.id}" title="Delete this puzzle">🗑</button>
        </div>`).join('') : '<div class="empty">Nothing in progress.</div>';
    html += '<div class="group">Solved</div>';
    html += solved.length ? solved.map(p => solvedRow(p, '#' + p.n)).join('') : '<div class="empty">None yet.</div>';
    $('listBody').innerHTML = html;
    $('listBody').querySelectorAll('[data-tune-for]').forEach(b => tuneButton(b, state.puzzles[b.dataset.tuneFor], '▶', '■'));
    renderSyncStatus();
    $('listPanel').hidden = false;
}

function showSettings() {
    document.querySelectorAll('[data-setting]').forEach(cb => (cb.checked = !!state.settings[cb.dataset.setting]));
    applySound();
    renderSyncStatus();
    $('settingsPanel').hidden = false;
}

function anyPanelOpen() {
    return !$('listPanel').hidden || !$('settingsPanel').hidden || !$('winPanel').hidden || !$('viewPanel').hidden || !$('storyPanel').hidden;
}
function closePanels() {
    if (!$('viewPanel').hidden && view && view.rec && view.rec === tuneRec) SFX.stop();
    ['listPanel', 'settingsPanel', 'viewPanel'].forEach(id => ($(id).hidden = true));
    if (!cur) startNew();
}

// ------------------------------------------------------------------ viewing and sharing

let view = null; // { def, rec, shared, solution }

// Shows a solved puzzle of yours (rec), or one shared through a link.
function showView(def, rec, shared) {
    view = { def, rec, shared, solution: !!rec };
    // Opened from the list: ‹ goes back to it, ✕ goes back to the puzzle.
    $('viewBack').hidden = $('listPanel').hidden;
    $('viewTitle').textContent = def.title + (!rec ? '' : def.case ? ' · Room ' + def.case.n : ' #' + rec.n);
    $('viewMeta').textContent = rec
        ? 'Solved ' + fmtDate(rec.solvedAt)
        : 'Shared with you';
    $('viewRules').replaceChildren(...['Normal sudoku rules apply.'].concat(def.rules).map(t => {
        const li = document.createElement('li');
        li.textContent = t;
        return li;
    }));
    $('viewShare').hidden = !rec;
    $('viewPlay').hidden = !!rec;
    $('viewPiece').hidden = $('viewTune').hidden = !rec;
    if (rec) {
        $('viewPiece').textContent = pieceName(rec);
        tuneButton($('viewTune'), rec);
    }
    drawView();
    $('viewPanel').hidden = false;
    $('viewPanel').scrollTop = 0;
}

function drawView() {
    $('viewBoard').innerHTML = drawStill(view.def, view.solution);
    $('viewFlip').textContent = view.solution ? 'Show the start' : view.rec ? 'Show the solution' : 'Peek at the solution';
}

const SHARE_KEYS = ['cages', 'thermos', 'arrows', 'dots', 'xv', 'whispers', 'renbans', 'dutch', 'palindromes', 'odds', 'evens'];

const toB64Url = bytes => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = t => fromB64(t.replace(/-/g, '+').replace(/_/g, '/'));

async function squeeze(bytes, how) {
    const stream = new Blob([bytes]).stream().pipeThrough(how === 'in' ? new CompressionStream('deflate-raw') : new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Packs a puzzle into a link. 'z' links are compressed, 'j' links are plain
// for browsers without CompressionStream.
async function shareLink(rec) {
    const d = rec.def, c = {};
    SHARE_KEYS.forEach(k => { if (d[k] && d[k].length) c[k] = d[k]; });
    const json = new TextEncoder().encode(JSON.stringify({
        v: 1, t: d.types, n: d.seed, g: d.givens.join(''), s: d.solution.join(''), c,
    }));
    const code = typeof CompressionStream === 'function' ? 'z' + toB64Url(await squeeze(json, 'in')) : 'j' + toB64Url(json);
    return SHARE_BASE + '#share=' + code;
}

// Reads a link back into a puzzle. Links can come from anywhere, so every
// field is checked and the title and rules come from this app, not the link.
async function readShareLink(code) {
    let bytes = fromB64Url(code.slice(1));
    if (code[0] === 'z') bytes = await squeeze(bytes, 'out');
    else if (code[0] !== 'j') return null;
    const o = JSON.parse(new TextDecoder().decode(bytes));
    const types = Array.isArray(o.t) ? o.t.filter(t => typeof t === 'string' && Object.hasOwn(E.TYPE_NAMES, t)) : [];
    const digits = t => typeof t === 'string' && /^[0-9]{81}$/.test(t) ? [...t].map(Number) : null;
    const givens = digits(o.g), solution = digits(o.s);
    if (!types.length || !givens || !solution || solution.includes(0)) return null;
    if (givens.some((g, i) => g && g !== solution[i])) return null;
    const cell = n => Number.isInteger(n) && n >= 0 && n < 81;
    const cells = a => Array.isArray(a) && a.length > 0 && a.length <= 81 && a.every(cell);
    const c = o.c && typeof o.c === 'object' ? o.c : {};
    const list = (k, ok) => (Array.isArray(c[k]) ? c[k] : []).filter(x => x && ok(x));
    const pair = ts => x => cell(x.a) && cell(x.b) && ts.includes(x.t);
    const def = {
        seed: Number.isInteger(o.n) ? o.n : 0, types, givens, solution,
        cages: list('cages', x => cells(x.cells) && Number.isInteger(x.sum) && x.sum > 0 && x.sum <= 45).map(x => ({ cells: x.cells, sum: x.sum })),
        thermos: list('thermos', cells), whispers: list('whispers', cells), renbans: list('renbans', cells),
        dutch: list('dutch', cells), palindromes: list('palindromes', x => cells(x) && x.length % 2 === 1),
        // Plain cell numbers, so cell 0 must survive (list() drops falsy items).
        odds: (Array.isArray(c.odds) ? c.odds : []).filter(cell), evens: (Array.isArray(c.evens) ? c.evens : []).filter(cell),
        arrows: list('arrows', x => cell(x.circle) && cells(x.path)).map(x => ({ circle: x.circle, path: x.path })),
        dots: list('dots', pair(['w', 'b'])).map(x => ({ a: x.a, b: x.b, t: x.t })),
        xv: list('xv', pair(['x', 'v'])).map(x => ({ a: x.a, b: x.b, t: x.t })),
        title: types.map(t => E.TYPE_NAMES[t]).join(' & '),
        rules: types.map(t => E.RULES[t]).filter(Boolean),
        grader: E.GRADER,
    };
    return { def };
}

const samePuzzle = (a, b) => a.seed === b.seed && a.solution.join('') === b.solution.join('');

async function openShareFromHash() {
    const m = /^#share=([zj][A-Za-z0-9_-]+)$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    let shared = null;
    try { shared = await readShareLink(m[1]); } catch (_) {}
    if (!shared) return toast('That puzzle link looks broken.');
    const mine = Object.values(state.puzzles).find(p => p.def && p.def.solution && samePuzzle(p.def, shared.def));
    if (mine && mine.status === 'solved') return showView(mine.def, mine);
    if (mine) { closePanels(); return openPuzzle(mine); }
    showView(shared.def, null, shared);
}

function backToList() {
    $('viewPanel').hidden = true;
    showList();
}
$('viewBack').onclick = backToList;

$('viewFlip').onclick = () => { view.solution = !view.solution; drawView(); };
$('viewPlay').onclick = () => { $('viewPanel').hidden = true; startNew(view.def); };
$('viewShare').onclick = async () => {
    const url = await shareLink(view.rec);
    const title = view.def.title + ' sudoku';
    if (navigator.share) {
        try { return await navigator.share({ title, text: 'Have a go at this ' + title + '.', url }); }
        catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch (_) { prompt('Copy this link:', url); }
};
window.addEventListener('hashchange', openShareFromHash);

// ------------------------------------------------------------------ celebrations
//
// When a move correctly completes a row, column, box, cage, line or X/V pair,
// it lights up. Effects go on their own layer (#fx), since the board is
// redrawn on every tap.

const fx = $('fx');
const FX_COLOUR = { row: '#ffcc00', col: '#ffcc00', box: '#ffcc00', cage: '#ff7a59', thermo: '#ff453a',
    whispers: '#34c759', renban: '#bf5af2', arrow: '#0a84ff', pair: '#64d2ff', dutch: '#ff9f0a', palindrome: '#a1a1a6', pipe: '#b87333', trail: '#c9d3e6' };
let unitsFor = null, units = [], doneUnits = new Set();

function buildUnits(def) {
    const out = [];
    E.HOUSES.forEach((h, k) => out.push({ key: 'h' + k, kind: k < 9 ? 'row' : k < 18 ? 'col' : 'box', cells: h }));
    (def.cages || []).forEach((c, k) => out.push({ key: 'k' + k, kind: 'cage', cells: c.cells }));
    (def.thermos || []).forEach((p, k) => out.push({ key: 't' + k, kind: 'thermo', cells: p, line: true }));
    (def.whispers || []).forEach((p, k) => out.push({ key: 'w' + k, kind: 'whispers', cells: p, line: true }));
    (def.renbans || []).forEach((p, k) => out.push({ key: 'r' + k, kind: 'renban', cells: p, line: true }));
    (def.dutch || []).forEach((p, k) => out.push({ key: 'u' + k, kind: 'dutch', cells: p, line: true }));
    (def.palindromes || []).forEach((p, k) => out.push({ key: 'p' + k, kind: 'palindrome', cells: p, line: true }));
    (def.arrows || []).forEach((a, k) => out.push({ key: 'a' + k, kind: 'arrow', cells: [a.circle].concat(a.path), line: true }));
    (def.xv || []).forEach((d, k) => out.push({ key: 'x' + k, kind: 'pair', cells: [d.a, d.b] }));
    (def.dots || []).forEach((d, k) => out.push({ key: 'd' + k, kind: 'pair', cells: [d.a, d.b] }));
    // An escape room's hidden rule mustn't glow in its own colour.
    if (def.mystery) out.forEach(u => { if (u.kind === def.mystery) u.kind = def.case && def.case.lineStyle === 'star' ? 'trail' : 'pipe'; });
    return out;
}

function completeUnits() {
    if (unitsFor !== cur.def) { unitsFor = cur.def; units = buildUnits(cur.def); }
    const sol = cur.def.solution;
    return new Set(units.filter(u => u.cells.every(i => digitAt(i) === sol[i])).map(u => u.key));
}

function resetCelebrations() {
    fx.innerHTML = '';
    doneUnits = completeUnits();
}

function checkCelebrations() {
    const now = completeUnits();
    const fresh = units.filter(u => now.has(u.key) && !doneUnits.has(u.key));
    doneUnits = now;
    if (fresh.length) celebrate(fresh);
}

const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

function sparks(x, y, n, reach, colour) {
    let s = '';
    for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + Math.random() * 0.6, d = reach * (0.55 + Math.random() * 0.6);
        const glyph = Math.random() < 0.3;
        const style = `--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px;--t:${(0.6 + Math.random() * 0.5).toFixed(2)}s`;
        s += glyph
            ? `<text class="fxSpark" x="${x}" y="${y}" font-size="34" text-anchor="middle" dominant-baseline="central" style="${style}">✨</text>`
            : `<circle class="fxSpark" cx="${x}" cy="${y}" r="${(5 + Math.random() * 6).toFixed(1)}" fill="${colour}" style="${style}"/>`;
    }
    return s;
}

function celebrate(list) {
    const big = list.filter(u => u.kind !== 'pair');
    const kind = !big.length ? 'pair' : big.some(u => u.kind === 'cage') ? 'cage' : big.some(u => u.line) ? 'line' : 'house';
    SFX.complete(piece(), kind, big.length);
    let s = '';
    list.forEach(u => {
        const colour = FX_COLOUR[u.kind];
        if (u.kind === 'pair') {
            const [x, y] = edgeMid(u.cells[0], u.cells[1]);
            s += `<circle class="fxRing" cx="${x}" cy="${y}" r="18" fill="none" stroke="${colour}" stroke-width="5"/>`;
            return;
        }
        // A wave of light along the unit's cells.
        u.cells.forEach((i, k) => {
            s += `<rect class="fxGlow" x="${E.colOf(i) * 100 + 3}" y="${E.rowOf(i) * 100 + 3}" width="94" height="94" rx="10" fill="${colour}" style="animation-delay:${k * 45}ms"/>`;
        });
        if (u.line) {
            const pts = u.cells.map(i => cx(i) + ',' + cy(i)).join(' ');
            const len = u.cells.slice(1).reduce((t, i, k) => t + Math.hypot(cx(i) - cx(u.cells[k]), cy(i) - cy(u.cells[k])), 0) + 1;
            s += `<polyline class="fxTrace" points="${pts}" fill="none" stroke="${colour}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${len}" stroke-dashoffset="${len}"/>`;
        }
        if (u.kind === 'cage' || u.line) {
            // Bigger cages and longer lines get a bigger burst.
            const n = u.cells.length;
            const mx = u.cells.reduce((t, i) => t + cx(i), 0) / n, my = u.cells.reduce((t, i) => t + cy(i), 0) / n;
            s += sparks(mx, my, 6 + n * (n >= 4 ? 5 : 3), 70 + n * 28, colour);
        }
    });
    if (big.length >= 2) {
        const at = lastSel >= 0 ? lastSel : big[0].cells[0];
        s += `<text class="fxCombo" x="${cx(at)}" y="${Math.max(cy(at), 120)}">Combo ×${big.length}!</text>`;
    }
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = s;
    fx.appendChild(g);
    setTimeout(() => g.remove(), 2000);
}

function confetti() {
    if (reduceMotion()) return;
    const box = document.createElement('div');
    box.id = 'confetti';
    const bits = ['🎉', '✨', '🔑', '⭐', '🎊', '🗝️'];
    for (let k = 0; k < 46; k++) {
        const el = document.createElement('span');
        el.textContent = bits[k % bits.length];
        el.style.left = (Math.random() * 100).toFixed(1) + 'vw';
        el.style.animationDuration = (2.2 + Math.random() * 2).toFixed(2) + 's';
        el.style.animationDelay = (Math.random() * 0.9).toFixed(2) + 's';
        box.appendChild(el);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 5500);
}

// ------------------------------------------------------------------ escape rooms
//
// A case is three puzzle records that share def.case. Rooms 2 and 3 start
// 'locked' and open as the room before is solved. Everything lives on the
// puzzle records, so cases sync like any other puzzle.

const caseRooms = id => Object.values(state.puzzles)
    .filter(p => p.def && p.def.case && p.def.case.id === id)
    .sort((a, b) => a.def.case.n - b.def.case.n);

function caseIds() {
    const out = [];
    state.order.forEach(id => {
        const p = state.puzzles[id];
        if (p && p.def && p.def.case && !out.includes(p.def.case.id)) out.push(p.def.case.id);
    });
    return out;
}

function caseInfo(id) {
    const rooms = caseRooms(id);
    const info = rooms.length ? rooms[0].def.case : null;
    const last = rooms[rooms.length - 1];
    return {
        rooms, info, last,
        complete: !!info && rooms.length === info.of && rooms.every(p => p.def.solution),
        open: rooms.find(p => p.status !== 'solved'),
        escaped: last && last.escapedAt,
    };
}

// The digits under room 1's 🔑 cells, once room 1 is solved.
function keyDigits(rooms) {
    const r1 = rooms[0];
    return (r1.def.marks || []).filter(m => m.kind === 'key').map(m => (r1.status === 'solved' ? r1.def.solution[m.cell] : '?'));
}

const para = t => '<p>' + esc(t) + '</p>';
// Older cases were all the Boiler Room, which had no exitName.
const exitName = info => info.exitName || 'The exit door';

function renderCaseBar() {
    const bar = $('caseBar');
    if (!cur || !cur.def.case) {
        bar.hidden = true;
        document.body.removeAttribute('data-room');
        return;
    }
    document.body.dataset.room = cur.def.room.theme;
    const c = caseInfo(cur.def.case.id);
    let html = `<span class="caseName">🗝️ ${esc(c.info.title)}</span>`;
    html += `<span class="chip" title="Keys from ${esc(c.rooms[0].def.room.name.replace(/^The /, 'the '))}">🔑 ${keyDigits(c.rooms).join(' · ')}</span>`;
    c.rooms.forEach(p => {
        if (p.status === 'solved') html += `<button class="chip" data-note="${p.id}" title="Read the note">📜 ${esc(p.def.room.name.replace(/^The /, ''))}</button>`;
    });
    if (cur.status === 'active' && cur.def.lockedCage != null && !cur.unlocked) html += '<button class="chip go" data-unlock="1">🔓 Use your keys</button>';
    if (cur.status === 'solved') {
        if (c.open) html += `<button class="chip go" data-goto="${c.open.id}">Continue → ${esc(c.open.def.room.name)}</button>`;
        else if (!c.escaped) html += `<button class="chip go" data-door="${c.info.id}">🚪 Go to ${esc(exitName(c.info).replace(/^The /, 'the '))}</button>`;
        else html += '<span class="chip">Escaped ✓</span>';
    }
    if (cur.status === 'solved') html += '<button class="chip" data-tune="1">▶ Play its tune</button>';
    bar.innerHTML = html;
    const tb = bar.querySelector('[data-tune]');
    if (tb) tuneButton(tb, cur);
    bar.hidden = false;
}

$('caseBar').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.note) {
        const rec = state.puzzles[b.dataset.note];
        return showStory({ icon: '📜', title: 'Note from ' + rec.def.room.name.replace(/^The /, 'the '), html: para(rec.def.room.note),
            buttons: [['Back', closeStory, true]] });
    }
    if (b.dataset.goto) return openPuzzle(state.puzzles[b.dataset.goto]);
    if (b.dataset.unlock) {
        const extra = document.createElement('div');
        extra.innerHTML = '<div class="lockTry" style="justify-content:center;margin-bottom:6px"><input id="storyLock" type="text" inputmode="numeric" maxlength="2" placeholder="?" autocomplete="off"></div>';
        const go = () => { if (tryUnlock($('storyLock').value)) closeStory(); else $('storyLock').value = ''; };
        extra.querySelector('input').onkeydown = e => { if (e.key === 'Enter') go(); };
        const info = cur.def.case;
        const how = info.keyHow ? 'Your note says: ' + info.keyHow + '.' : 'Add up the digits under your keys.';
        return showStory({ icon: '🔑', title: 'The keyhole', html: para('One cage has a keyhole instead of a total. What number do your keys make? ' + how),
            extra, buttons: [['Try the key', go, true], ['Not yet', closeStory]] });
    }
    if (b.dataset.door) return showExit(b.dataset.door);
});

function showStory(o) {
    $('storyIcon').textContent = o.icon || '';
    $('storyTitle').textContent = o.title || '';
    $('storyText').innerHTML = o.html || '';
    const extra = $('storyExtra');
    extra.replaceChildren();
    if (o.extra) extra.appendChild(o.extra);
    const btns = $('storyBtns');
    btns.replaceChildren();
    (o.buttons || []).forEach(([label, fn, accent]) => {
        const b = document.createElement('button');
        b.className = 'wide' + (accent ? ' accent' : '');
        b.textContent = label;
        b.onclick = fn;
        btns.appendChild(b);
    });
    $('storyPanel').hidden = false;
    $('storyPanel').scrollTop = 0;
}
function closeStory() { $('storyPanel').hidden = true; }
$('storyPanel').querySelector('.storyClose').onclick = closeStory;

const roomHeading = rec => `<p><b>${rec.def.room.icon} Room ${rec.def.case.n}: ${esc(rec.def.room.name)}</b><br>${esc(rec.def.room.intro)}</p>`;

async function startCase() {
    if (busy) return;
    ['listPanel', 'settingsPanel', 'viewPanel', 'winPanel', 'storyPanel'].forEach(id => ($(id).hidden = true));
    setBusy(true, 'Building an escape room…');
    let c;
    try {
        c = await generateCase();
    } catch (e) {
        console.error(e);
        return toast('Couldn\'t build an escape room - try again');
    } finally {
        setBusy(false);
    }
    if (cur && cur.status === 'active') cur.status = 'skipped';
    const now = Date.now();
    const recs = c.rooms.map((def, k) => ({
        id: 'p' + (now + k).toString(36), def, status: k ? 'locked' : 'active', createdAt: now + k, hints: 0,
        digits: blank(), corner: blank(), centre: blank(), colours: blank(),
    }));
    // Counts as the latest move, so both devices carry on with the new case.
    recs[0].updatedAt = now;
    recs.forEach(rec => {
        rec.piece = choosePiece();
        state.puzzles[rec.id] = rec;
        state.order.unshift(rec.id);
    });
    renumber();
    openPuzzle(recs[0]);
    save();
    scheduleSync(500);
    const info = recs[0].def.case;
    showStory({ icon: '🗝️', title: info.title, html: para(info.intro) + roomHeading(recs[0]),
        buttons: [['Enter ' + recs[0].def.room.name.replace(/^The /, 'the '), closeStory, true]] });
}

function resumeCase(id) {
    closePanels();
    const c = caseInfo(id);
    if (c.open) return openPuzzle(c.open);
    showExit(id);
}

function caseRoomSolved(rec) {
    const c = caseInfo(rec.def.case.id);
    const room = rec.def.room;
    let html = `<p class="nowPlaying">${esc(pieceName(rec))}</p>`;
    if (rec.def.case.n === 1) html += `<p class="found">You found: ${keyDigits(c.rooms).map(d => '🔑' + d).join('  ')}</p>`;
    html += para(room.note);
    renderCaseBar();
    const extra = tuneButton(Object.assign(document.createElement('button'), { className: 'tuneBtn' }), rec, '▶ Play it again');
    if (!c.open) {
        return showStory({ icon: room.icon, title: room.name + ': solved', html, extra,
            buttons: [['Go to ' + exitName(rec.def.case).replace(/^The /, 'the ') + ' 🚪', () => showExit(rec.def.case.id), true]] });
    }
    // Ready to play, and newest, so the other device carries on with it too.
    const next = c.open;
    if (next.status === 'locked') next.status = 'skipped';
    next.updatedAt = Date.now();
    save();
    scheduleSync(500);
    html += roomHeading(next);
    showStory({ icon: room.icon, title: room.name + ': solved', html, extra,
        buttons: [['Go to ' + next.def.room.name.replace(/^The /, 'the '), () => { closeStory(); openPuzzle(next); }, true]] });
}

let dials = [0, 0, 0, 0];

function showExit(id) {
    const c = caseInfo(id);
    if (!c.complete) return;
    if (c.escaped) return escaped(c);
    dials = [0, 0, 0, 0];
    const extra = document.createElement('div');
    extra.innerHTML = `
        <ul class="dialHints">${c.info.dials.map(d => '<li>' + esc(d.text) + '</li>').join('')}</ul>
        <div class="roomThumbs">${c.rooms.map(p => `<button data-room="${p.id}" title="Look closer"><svg viewBox="-6 -6 912 912">${drawStill(p.def, true)}</svg>${esc(p.def.room.name)}</button>`).join('')}</div>
        <div class="padlock">${c.info.dials.map((d, k) => `<div class="dial"><span class="sym">${d.sym}</span><button data-up="${k}" aria-label="Up">▲</button><span class="val" id="dial${k}">0</span><button data-down="${k}" aria-label="Down">▼</button></div>`).join('')}</div>
        <p class="lockMsg" id="lockMsg">Tap a room to look closer.</p>`;
    extra.onclick = e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.room) { const rec = state.puzzles[b.dataset.room]; return showView(rec.def, rec); }
        const k = b.dataset.up != null ? +b.dataset.up : +b.dataset.down;
        dials[k] = (dials[k] + (b.dataset.up != null ? 1 : 9)) % 10;
        $('dial' + k).textContent = dials[k];
    };
    const tryDoor = () => {
        if (dials.join('') === c.info.code.join('')) return openDoor(id);
        const box = $('storyBox');
        box.classList.remove('shake');
        void box.offsetWidth;
        box.classList.add('shake');
        $('lockMsg').textContent = 'The lock doesn\'t budge.';
    };
    const stuck = () => {
        $('lockMsg').textContent = 'Read each clue above slowly. The ★ ◆ ▲ symbols sit on cells in that room (one or two cells, as the clue says), ' +
            'and the solved digits are shown, so tap a room to look closer. ● is worked out from the clue alone.';
    };
    showStory({ icon: '🚪', title: exitName(c.info), html: para(c.info.exit), extra,
        buttons: [['Try the door', tryDoor, true], ['I\'m stuck', stuck]] });
}

function openDoor(id) {
    const c = caseInfo(id);
    c.last.escapedAt = Date.now();
    c.last.updatedAt = c.last.escapedAt;
    save();
    scheduleSync(500);
    renderCaseBar();
    confetti();
    SFX.complete(piece(c.last), 'house', 3);
    escaped(caseInfo(id));
}

function escaped(c) {
    // No escape time shown: rooms are played a few digits at a time across the day.
    showStory({ icon: '🎉', title: 'You escaped!', html: para(c.info.escaped),
        buttons: [['Another escape room', startCase, true], ['Back to normal puzzles', () => { closeStory(); if (!cur || cur.status === 'solved') startNew(); }]] });
}

// ------------------------------------------------------------------ input

function cellFromEvent(e) {
    const r = board.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 912 - 6, y = ((e.clientY - r.top) / r.height) * 912 - 6;
    if (!(x >= 0 && y >= 0 && x < 900 && y < 900)) return -1; // also catches NaN before the board has a size
    return Math.floor(y / 100) * 9 + Math.floor(x / 100);
}

// Pins the digit in cell i: every cell holding it stays highlighted while you
// carry on selecting other cells. Double-clicking an empty cell changes nothing.
function selectSameDigit(i) {
    const d = i >= 0 ? digitAt(i) : 0;
    if (!d) return;
    pinnedDigit = d;
    render();
}
function unpinDigit() {
    if (!pinnedDigit) return;
    pinnedDigit = 0;
    render();
}
// A click on the empty page around the puzzle unpins, as do Escape and pinning
// another digit.
// Capture phase: it must look at the click before the board's own handler
// redraws the board, which detaches the clicked shape (closest() would then
// miss #board and wrongly unpin).
document.addEventListener('pointerdown', e => {
    if (!pinnedDigit || anyPanelOpen()) return;
    // Anywhere in the playing column (header, rules, board, pad, buttons and
    // the gaps between them) or the cage panel keeps the pin; only the empty
    // page around them clears it.
    if (e.target.closest('#main, #cagePanel, button, input, select, label, a')) return;
    unpinDigit();
}, { capture: true });

// Double-clicks and double-taps are spotted here, for mouse and finger alike.
// The browser's own dblclick never reaches the board: every press redraws the
// board, which removes the element pressed on, so no click or dblclick fires.
const DOUBLE_MS = 400;
let lastCellTap = { i: -1, at: 0 };
board.addEventListener('pointerdown', e => {
    const i = cellFromEvent(e);
    if (i < 0) return;
    e.preventDefault();
    const now = Date.now();
    const again = lastCellTap.i === i && now - lastCellTap.at < DOUBLE_MS;
    lastCellTap = again ? { i: -1, at: 0 } : { i, at: now };
    if (again) return selectSameDigit(i);
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
        sel.has(i) && sel.size > 1 ? sel.delete(i) : sel.add(i);
    } else {
        sel = new Set([i]);
    }
    lastSel = i;
    dragging = true;
    board.setPointerCapture(e.pointerId);
    render();
});
// Every cell on the straight line from cell a to cell b (b included). A quick
// drag can jump several cells between two pointer events; this fills the gap.
function cellsBetween(a, b) {
    const r0 = E.rowOf(a), c0 = E.colOf(a), dr = E.rowOf(b) - r0, dc = E.colOf(b) - c0;
    const n = Math.max(Math.abs(dr), Math.abs(dc)), out = [];
    for (let t = 1; t <= n; t++) out.push(Math.round(r0 + (dr * t) / n) * 9 + Math.round(c0 + (dc * t) / n));
    return out;
}
board.addEventListener('pointermove', e => {
    if (!dragging) return;
    const i = cellFromEvent(e);
    if (i < 0 || i === lastSel) return;
    const add = lastSel >= 0 ? cellsBetween(lastSel, i) : [i];
    lastSel = i;
    if (add.some(j => !sel.has(j))) {
        add.forEach(j => sel.add(j));
        render();
    }
});
board.addEventListener('pointerup', () => (dragging = false));

document.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement) return;
    if (anyPanelOpen()) {
        if (e.key === 'Escape') {
            if (!$('viewPanel').hidden && !$('viewBack').hidden) backToList();
            else if (!$('listPanel').hidden || !$('settingsPanel').hidden || !$('viewPanel').hidden) closePanels();
            else closeStory();
        }
        return;
    }
    const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (m && !e.metaKey) {
        const d = +m[1];
        e.preventDefault();
        if (d === 0) return clearSelected();
        let md = mode;
        if (e.shiftKey) md = 'corner';
        if (e.ctrlKey || e.altKey) md = 'centre';
        return enter(d, md);
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // W A S D move like the arrow keys (Shift adds to the selection). Read by
    // physical key, so they sit in the same place on any keyboard layout.
    const wasd = { KeyW: 'arrowup', KeyA: 'arrowleft', KeyS: 'arrowdown', KeyD: 'arrowright' };
    const k = wasd[e.code] || e.key.toLowerCase();
    if (k === 'z') return setMode('normal');
    if (k === 'x') return setMode('corner');
    if (k === 'c') return setMode('centre');
    if (k === 'v') return setMode('colour');
    if (k === ' ') { e.preventDefault(); return setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]); }
    if (k === 'backspace' || k === 'delete') { e.preventDefault(); return clearSelected(); }
    if (k === 'escape') { sel = new Set(); pinnedDigit = 0; closeHint(); return render(); }
    const moves = { arrowup: -9, arrowdown: 9, arrowleft: -1, arrowright: 1 };
    if (k in moves) {
        e.preventDefault();
        let i = lastSel < 0 ? 40 : lastSel;
        const r = E.rowOf(i), c = E.colOf(i);
        if (k === 'arrowup') i = ((r + 8) % 9) * 9 + c;
        if (k === 'arrowdown') i = ((r + 1) % 9) * 9 + c;
        if (k === 'arrowleft') i = r * 9 + (c + 8) % 9;
        if (k === 'arrowright') i = r * 9 + (c + 1) % 9;
        if (e.shiftKey) sel.add(i); else sel = new Set([i]);
        lastSel = i;
        render();
    }
});

$('pad').addEventListener('click', e => {
    const b = e.target.closest('button[data-d]');
    if (b) enter(+b.dataset.d);
});
document.querySelectorAll('#modes button').forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
$('clearBtn').onclick = clearSelected;
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
$('hintBtn').onclick = doHint;
$('skipBtn').onclick = () => {
    if (!cur || busy) return;
    toast(cur.def.title + ' #' + cur.n + ' set aside - find it under ☰');
    startNew();
};
$('listBtn').onclick = showList;
$('settingsBtn').onclick = showSettings;
document.querySelectorAll('.panel .close').forEach(b => (b.onclick = closePanels));
$('listBody').addEventListener('click', e => {
    const cb = e.target.closest('button[data-case]');
    if (cb) return resumeCase(cb.dataset.case);
    const v = e.target.closest('[data-view]');
    if (v) {
        const rec = state.puzzles[v.dataset.view];
        return showView(rec.def, rec);
    }
    const x = e.target.closest('[data-expand]');
    if (x && !e.target.closest('button')) {
        openCases.has(x.dataset.expand) ? openCases.delete(x.dataset.expand) : openCases.add(x.dataset.expand);
        return showList();
    }
    const del = e.target.closest('button[data-delete]');
    if (del) return deletePuzzle(state.puzzles[del.dataset.delete]);
    const b = e.target.closest('button[data-resume]');
    if (!b) return;
    closePanels();
    openPuzzle(state.puzzles[b.dataset.resume]);
});
$('newBtn').onclick = () => { closePanels(); startNew(); };
$('winNext').onclick = () => { $('winPanel').hidden = true; startNew(); };
$('winCase').onclick = startCase;
$('newCaseBtn').onclick = startCase;
document.querySelectorAll('[data-setting]').forEach(cb => cb.addEventListener('change', () => {
    state.settings[cb.dataset.setting] = cb.checked;
    if (cb.dataset.setting === 'sound') applySound();
    save();
    render();
}));

function applySound() {
    SFX.setEnabled(state.settings.sound);
    $('soundBtn').textContent = state.settings.sound ? '🔊' : '🔇';
    $('soundBtn').title = state.settings.sound ? 'Sound on (tap to mute)' : 'Sound off (tap to turn on)';
    $('soundStyle').value = state.settings.soundStyle;
    $('soundStyle').disabled = !state.settings.sound;
}
$('soundBtn').onclick = () => {
    state.settings.sound = !state.settings.sound;
    applySound();
    save();
    if (state.settings.sound && cur) SFX.complete(piece(), 'house', 1);
};
$('soundStyle').onchange = () => {
    state.settings.soundStyle = $('soundStyle').value;
    save();
};
// Browsers (iOS especially) only let sound start inside a tap or key press.
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => SFX.unlock(), { capture: true }));
$('restartBtn').onclick = () => {
    if (!cur || !confirm('Clear all your digits, marks and colours on this puzzle?')) return;
    const before = snapshot();
    cur.digits = blank(); cur.corner = blank(); cur.centre = blank(); cur.colours = blank();
    if (cur.status === 'solved') cur.status = 'active';
    closePanels();
    commit(before);
};
$('hintBtn').addEventListener('contextmenu', e => { e.preventDefault(); checkGrid(); });

document.addEventListener('visibilitychange', () => { if (document.hidden) flush(true); });
window.addEventListener('pagehide', () => flush(true));


// ------------------------------------------------------------------ sync
//
// Progress follows you between the Mac and the phone through progress.json
// in a private GitHub repo. Each side syncs when it opens, when it comes
// back to the front, and a few seconds after a move. For every puzzle the
// copy with the latest move wins. The Mac goes through the local server,
// which keeps its token in the Keychain; the phone keeps its own token in
// the app. Puzzles that were only opened, never played, aren't synced.

const SYNC_REPO = 'sudoku-progress', SYNC_FILE = 'progress.json', SYNC_CONF = 'sudoku-sync';
const SYNC_DELAY = 4000;

function syncConf() {
    try { return JSON.parse(localStorage.getItem(SYNC_CONF) || 'null'); } catch (_) { return null; }
}
function setSyncConf(conf) {
    try { conf ? localStorage.setItem(SYNC_CONF, JSON.stringify(conf)) : localStorage.removeItem(SYNC_CONF); } catch (_) {}
}

function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
const fromB64 = t => Uint8Array.from(atob(t.replace(/\s+/g, '')), ch => ch.charCodeAt(0));

class SyncConflict extends Error {}

async function github(conf, method, path, body) {
    const r = await fetch((conf.api || 'https://api.github.com') + path, {
        method, cache: 'no-store',
        headers: { Authorization: 'Bearer ' + conf.token, Accept: 'application/vnd.github+json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, json };
}

async function githubFile(conf) {
    if (!conf.owner) {
        const me = await github(conf, 'GET', '/user');
        if (me.status !== 200) throw new Error('GitHub didn\'t accept the token');
        conf.owner = me.json.login;
        setSyncConf(conf);
    }
    return '/repos/' + conf.owner + '/' + SYNC_REPO + '/contents/' + SYNC_FILE;
}

// { configured, sha, data } from wherever this copy syncs to.
async function pullRemote() {
    if (!useLocal) {
        const r = await fetch('api/sync', { headers: { 'X-Sudoku': '1' }, cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'sync failed');
        return j;
    }
    const conf = syncConf();
    if (!conf || !conf.token) return { configured: false };
    const r = await github(conf, 'GET', await githubFile(conf));
    if (r.status === 404) return { configured: true, sha: null, data: null };
    if (r.status !== 200) throw new Error('GitHub said ' + r.status);
    return { configured: true, sha: r.json.sha, data: JSON.parse(new TextDecoder().decode(fromB64(r.json.content))) };
}

async function pushRemote(sha, data) {
    if (!useLocal) {
        const r = await fetch('api/sync', { method: 'PUT', headers: { 'X-Sudoku': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ sha, data }) });
        const j = await r.json();
        if (r.status === 409) throw new SyncConflict();
        if (!r.ok) throw new Error(j.error || 'sync failed');
        return j.sha;
    }
    const conf = syncConf();
    const body = { message: 'Sync from phone', content: toB64(new TextEncoder().encode(JSON.stringify(data))) };
    if (sha) body.sha = sha;
    const r = await github(conf, 'PUT', await githubFile(conf), body);
    if (r.status === 409 || r.status === 422) throw new SyncConflict();
    if (r.status === 404) throw new Error('Can\'t find the ' + SYNC_REPO + ' repo - check the token can reach it');
    if (r.status !== 200 && r.status !== 201) throw new Error('GitHub said ' + r.status);
    return r.json.content.sha;
}

// How much has been done on a puzzle: digits, marks, colours and hints.
const progress = p => (p.hints || 0) + ['digits', 'corner', 'centre', 'colours'].reduce((n, k) => n + (p[k] || []).filter(Boolean).length, 0);
const untouched = p => !p.updatedAt && !progress(p);

// Played puzzles, plus the one on screen even before its first move, so the
// other device picks up a newly started puzzle instead of drawing its own.
function syncable() {
    const out = {};
    for (const [id, p] of Object.entries(state.puzzles)) if (!untouched(p) || id === state.currentId || (p.def && p.def.case)) out[id] = p;
    return out;
}

// Takes in every remote puzzle that is new here or has a later move.
function mergeRemote(remote, deleted) {
    let changed = 0;
    for (const [id, at] of Object.entries(deleted || {})) if (!state.deleted[id]) state.deleted[id] = at;
    if (dropDeleted()) changed++;
    for (const [id, p] of Object.entries(remote || {})) {
        if (!p || !p.def || state.deleted[id]) continue;
        const mine = state.puzzles[id];
        if (!mine || (p.updatedAt || 0) > (mine.updatedAt || 0)) {
            state.puzzles[id] = p;
            changed++;
        }
    }
    if (changed) {
        // Don't later serve up a puzzle that's already on the list.
        const have = new Set(Object.values(state.puzzles).map(p => p.def.seed + '|' + p.def.types));
        state.queue = state.queue.filter(d => !have.has(d.seed + '|' + d.types));
        renumber();
    }
    return changed;
}

function needsPush(remote, deleted) {
    remote = remote || {};
    deleted = deleted || {};
    const mine = syncable();
    return Object.keys(state.deleted).some(id => !deleted[id]) || Object.values(mine).some(p => !remote[p.id] || (p.updatedAt || 0) > (remote[p.id].updatedAt || 0)) ||
        Object.keys(remote).some(id => !mine[id]);
}

// Deletes an unfinished puzzle for good. The numbers close up behind it, so
// the next new puzzle takes the freed number. A note of the deletion syncs,
// so the other devices drop it too instead of bringing it back.
function deletePuzzle(p) {
    if (!p || p.status === 'solved' || p.def.case) return;
    if (!confirm(`Delete ${p.def.title} #${p.n}? Your digits and marks on it can't be brought back.`)) return;
    const wasCur = p === cur;
    state.deleted[p.id] = Date.now();
    delete state.puzzles[p.id];
    renumber();
    save();
    scheduleSync(500);
    if (wasCur) {
        cur = null;
        state.currentId = null;
        closePanels(); // starts the next puzzle
    } else {
        showList();
    }
    toast('Puzzle deleted');
}

// Drops every puzzle that a device has deleted. True if any went.
function dropDeleted() {
    let gone = false;
    for (const id of Object.keys(state.deleted)) if (state.puzzles[id]) { delete state.puzzles[id]; gone = true; }
    return gone;
}

// Puzzles are numbered by when they were started, so both devices agree.
function renumber() {
    state.order = Object.keys(state.puzzles).sort((a, b) => (state.puzzles[b].createdAt || 0) - (state.puzzles[a].createdAt || 0));
    state.order.slice().reverse().forEach((id, k) => (state.puzzles[id].n = k + 1));
    state.counter = state.order.length;
}

// Carries on with whichever unfinished puzzle was played most recently, or
// failing that the one started most recently. Both devices use the same
// rule, so they settle on the same puzzle. Any other puzzle that was never
// played is dropped.
function pickCurrent() {
    const open = state.order.map(id => state.puzzles[id]).filter(p => p.status !== 'solved' && p.status !== 'locked' && p.digits);
    const latest = open.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) ||
        (b.createdAt || 0) - (a.createdAt || 0))[0];
    open.filter(p => p !== latest).forEach(p => {
        if (untouched(p) && !p.def.case) {
            delete state.puzzles[p.id];
        } else if (p.status === 'active') {
            p.status = 'skipped';
        }
    });
    renumber();
    return latest;
}

let syncRun = null, syncAgain = false, syncTimer = null, lastSyncAt = 0;
let syncStatus = { state: 'unknown', text: '' };

function setSyncStatus(st, text) {
    syncStatus = { state: st, text: text || '', at: Date.now() };
    renderSyncStatus();
}

function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, delay == null ? SYNC_DELAY : delay);
}

function syncNow() {
    clearTimeout(syncTimer);
    syncTimer = null;
    if (syncRun) { syncAgain = true; return syncRun; }
    lastSyncAt = Date.now();
    syncRun = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const remote = await pullRemote();
            if (!remote.configured) { setSyncStatus('off'); return; }
            const before = cur;
            const changed = mergeRemote(remote.data && remote.data.puzzles, remote.data && remote.data.deleted);
            if (changed) {
                const latest = pickCurrent();
                if (latest && (!before || latest !== before || state.puzzles[before.id] !== before)) {
                    cur = null;
                    openPuzzle(latest);
                    if (latest !== before && before) toast('Carrying on with ' + latest.def.title + ' #' + latest.n + ' from your other device');
                } else if (!latest) {
                    await startNew();
                }
                save();
            }
            if (!needsPush(remote.data && remote.data.puzzles, remote.data && remote.data.deleted)) break;
            try {
                await pushRemote(remote.sha, { version: 1, puzzles: syncable(), deleted: state.deleted });
                break;
            } catch (e) {
                if (!(e instanceof SyncConflict) || attempt === 2) throw e;
            }
        }
        setSyncStatus('ok');
    })().catch(e => {
        // fetch throws a TypeError when the network or GitHub can't be reached.
        setSyncStatus(navigator.onLine === false || e instanceof TypeError ? 'offline' : 'error', e.message);
    }).finally(() => {
        syncRun = null;
        if (syncAgain) { syncAgain = false; scheduleSync(1000); }
    });
    return syncRun;
}

function syncStatusText() {
    const s = syncStatus;
    if (s.state === 'off') return useLocal ? 'Sync isn\'t set up on this device.' : 'Sync isn\'t set up: no sudoku-sync-token in the Keychain.';
    if (s.state === 'ok') return '☁︎ Synced at ' + new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (s.state === 'offline') return 'Can\'t reach GitHub right now - it will sync on your next move or when you reopen the app.';
    if (s.state === 'error') return 'Couldn\'t sync: ' + s.text;
    return 'Syncing…';
}

function renderSyncStatus() {
    const text = syncStatusText();
    document.querySelectorAll('.syncStatus').forEach(el => (el.textContent = text));
    const conf = useLocal ? syncConf() : null;
    $('syncSetup').hidden = !useLocal || !!(conf && conf.token);
    $('syncLinked').hidden = useLocal && !(conf && conf.token);
    $('syncForget').hidden = !useLocal;
}

$('syncSave').onclick = () => {
    const token = $('syncToken').value.trim();
    if (!token) return;
    $('syncToken').value = '';
    setSyncConf({ token });
    setSyncStatus('unknown');
    syncNow();
};
$('syncNowBtn').onclick = () => { setSyncStatus('unknown'); syncNow(); };
$('syncForget').onclick = () => {
    if (!confirm('Stop syncing on this device? Your puzzles stay here.')) return;
    setSyncConf(null);
    setSyncStatus('off');
};

// Catches up whenever the app comes back to the front (the phone app and
// the Mac popover usually stay alive in the background), and every 30
// seconds while it's on screen.
function syncIfStale(ms) {
    if (!document.hidden && !syncRun && Date.now() - lastSyncAt > ms) syncNow();
}
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncIfStale(3000);
    else if (syncTimer) syncNow(); // send a pending move before iOS suspends the app
});
window.addEventListener('focus', () => syncIfStale(3000));
window.addEventListener('pageshow', () => syncIfStale(3000));
window.addEventListener('online', () => syncNow());
setInterval(() => syncIfStale(30000), 10000);

// The board always fits the screen, so stop iOS pinch-zooming the page.
['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));

// With zoom off, iOS turns a quick second tap into a scroll that shifts the
// whole page. Swallow that second tap and press the button it landed on
// ourselves. Board taps need no help: they're read on pointerdown.
let lastTapAt = 0, tapMoved = false;
document.addEventListener('touchstart', () => (tapMoved = false), { passive: true });
document.addEventListener('touchmove', () => (tapMoved = true), { passive: true });
document.addEventListener('touchend', e => {
    if (e.touches.length) return;
    const now = Date.now();
    if (tapMoved) { lastTapAt = 0; return; }
    if (now - lastTapAt < 350) {
        e.preventDefault();
        const el = board.contains(e.target) ? null : e.target.closest('button, label, summary, a, input');
        if (el && el.matches('input:not([type=checkbox])')) el.focus();
        else if (el) el.click();
        lastTapAt = 0;
        return;
    }
    lastTapAt = now;
}, { passive: false });

// ------------------------------------------------------------------ start

(async () => {
    await load();
    applySound();
    // The hosted copy (phone) keeps progress in the browser: ask iOS not to
    // clear it, and cache the files so it works offline.
    if (useLocal) {
        try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
        if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }
    }
    // Catch up with the other device before choosing what to show, but
    // don't wait long when offline.
    const rec = state.currentId && state.puzzles[state.currentId];
    if (rec && rec.status !== 'solved' && rec.digits) cur = rec;
    await Promise.race([syncNow(), new Promise(r => setTimeout(r, 5000))]);
    const latest = pickCurrent();
    cur = null;
    // Someone opening a shared link sees that puzzle first, rather than a
    // random one being started behind it.
    const sharing = location.hash.startsWith('#share=');
    if (latest) openPuzzle(latest);
    else if (!sharing) await startNew();
    renderPad();
    fillQueue();
    if (sharing) await openShareFromHash();
    if (!cur && !anyPanelOpen()) await startNew();
})();
})();
