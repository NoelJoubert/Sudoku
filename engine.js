// Sudoku engine: variant constraints, solver, human-style grader, hints and
// puzzle generator. Runs in the page, in the generator worker, and in Node
// (for tests). No dependencies.
(function (root) {
'use strict';

// ------------------------------------------------------------------ basics

const ALL = 0x1ff;
const bit = d => 1 << (d - 1);
const POP = new Uint8Array(512);
const DIGITS = [];
for (let m = 0; m < 512; m++) {
    const ds = [];
    for (let d = 1; d <= 9; d++) if (m & bit(d)) ds.push(d);
    POP[m] = ds.length;
    DIGITS.push(ds);
}
const lowDigit = m => 32 - Math.clz32(m & -m);

const rowOf = i => (i / 9) | 0;
const colOf = i => i % 9;
const boxOf = i => 3 * ((rowOf(i) / 3) | 0) + ((colOf(i) / 3) | 0);
const cellName = i => 'r' + (rowOf(i) + 1) + 'c' + (colOf(i) + 1);

const HOUSES = [];
for (let r = 0; r < 9; r++) HOUSES.push([...Array(9)].map((_, c) => r * 9 + c));
for (let c = 0; c < 9; c++) HOUSES.push([...Array(9)].map((_, r) => r * 9 + c));
for (let b = 0; b < 9; b++) {
    const r0 = 3 * ((b / 3) | 0), c0 = 3 * (b % 3), cells = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push((r0 + r) * 9 + c0 + c);
    HOUSES.push(cells);
}
const houseName = h => (h < 9 ? 'row ' + (h + 1) : h < 18 ? 'column ' + (h - 8) : 'box ' + (h - 17));
const HOUSES_OF = [...Array(81)].map((_, i) => [rowOf(i), 9 + colOf(i), 18 + boxOf(i)]);

const SEES = new Uint8Array(81 * 81);
const PEERS = [...Array(81)].map(() => []);
for (let i = 0; i < 81; i++) for (let j = 0; j < 81; j++) {
    if (i !== j && (rowOf(i) === rowOf(j) || colOf(i) === colOf(j) || boxOf(i) === boxOf(j))) {
        SEES[i * 81 + j] = 1;
        PEERS[i].push(j);
    }
}

const NB4 = [...Array(81)].map((_, i) => {
    const r = rowOf(i), c = colOf(i), out = [];
    if (r > 0) out.push(i - 9);
    if (r < 8) out.push(i + 9);
    if (c > 0) out.push(i - 1);
    if (c < 8) out.push(i + 1);
    return out;
});
const NB8 = [...Array(81)].map((_, i) => {
    const r = rowOf(i), c = colOf(i), out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < 9 && cc >= 0 && cc < 9) out.push(rr * 9 + cc);
    }
    return out;
});

function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = (r, arr) => arr[(r() * arr.length) | 0];
function shuffle(r, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = (r() * (i + 1)) | 0;
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
const randInt = (r, lo, hi) => lo + ((r() * (hi - lo + 1)) | 0);

// ------------------------------------------------------------------ rules

const RULES = {
    classic: 'Normal sudoku rules apply.',
    killer: 'Digits in a cage sum to the number in its corner. Digits can\'t repeat in a cage.',
    thermo: 'Digits on a thermometer strictly increase from the bulb end.',
    arrow: 'Digits on an arrow sum to the digit in its circle. Digits may repeat on an arrow if sudoku rules allow.',
    kropki: 'A white dot joins consecutive digits. A black dot joins digits where one is double the other. Not all dots are given.',
    xv: 'Digits joined by an X sum to 10. Digits joined by a V sum to 5. Not all X\'s and V\'s are given.',
    whispers: 'Neighbouring digits on a green line differ by at least 5.',
    renban: 'A purple line holds a set of consecutive digits, in any order, with no repeats.',
};
const TYPE_NAMES = {
    classic: 'Classic', killer: 'Killer', thermo: 'Thermo', arrow: 'Arrow', kropki: 'Kropki',
    xv: 'XV', whispers: 'German Whispers', renban: 'Renban',
};

// ------------------------------------------------------------------ model

function supTables(pred) {
    const fwd = new Uint16Array(10), rev = new Uint16Array(10);
    for (let a = 1; a <= 9; a++) for (let b = 1; b <= 9; b++) {
        if (pred(a, b)) { fwd[a] |= bit(b); rev[b] |= bit(a); }
    }
    return { fwd, rev };
}
const REL = {
    inc: supTables((a, b) => a < b),
    whisper: supTables((a, b) => Math.abs(a - b) >= 5),
    white: supTables((a, b) => Math.abs(a - b) === 1),
    black: supTables((a, b) => a === 2 * b || b === 2 * a),
    x: supTables((a, b) => a + b === 10),
    v: supTables((a, b) => a + b === 5),
};

// Turns a puzzle definition into constraint objects the solvers use.
function compile(def) {
    const cons = [];
    const add = c => { c.id = cons.length; cons.push(c); };
    (def.thermos || []).forEach(p => add({ kind: 'chain', type: 'thermo', cells: p, links: p.slice(1).map(() => REL.inc),
        label: 'the thermometer from ' + cellName(p[0]) }));
    (def.whispers || []).forEach(p => add({ kind: 'chain', type: 'whispers', cells: p, links: p.slice(1).map(() => REL.whisper),
        label: 'the green line from ' + cellName(p[0]) }));
    (def.dots || []).forEach(d => add({ kind: 'chain', type: 'kropki', cells: [d.a, d.b], links: [d.t === 'w' ? REL.white : REL.black],
        label: 'the ' + (d.t === 'w' ? 'white' : 'black') + ' dot between ' + cellName(d.a) + ' and ' + cellName(d.b) }));
    (def.xv || []).forEach(d => add({ kind: 'chain', type: 'xv', cells: [d.a, d.b], links: [d.t === 'x' ? REL.x : REL.v],
        label: 'the ' + d.t.toUpperCase() + ' between ' + cellName(d.a) + ' and ' + cellName(d.b) }));
    (def.cages || []).forEach(c => add({ kind: 'group', type: 'killer', cells: c.cells, sum: c.sum, distinct: true,
        label: 'the ' + c.sum + ' cage at ' + cellName(Math.min(...c.cells)) }));
    (def.arrows || []).forEach(a => add({ kind: 'group', type: 'arrow', cells: [a.circle].concat(a.path), distinct: false,
        label: 'the arrow from ' + cellName(a.circle) }));
    (def.renbans || []).forEach(p => add({ kind: 'group', type: 'renban', cells: p, distinct: true,
        label: 'the purple line from ' + cellName(p[0]) }));
    return { def, cons };
}

// Each apply returns -1 (contradiction), 0 (no change) or 1 (changed).
function applyChain(c, cand) {
    let changed = 0, again = true;
    while (again) {
        again = false;
        for (let j = 0; j < c.links.length; j++) {
            const a = c.cells[j], b = c.cells[j + 1], rel = c.links[j];
            let na = 0, nb = 0;
            for (const d of DIGITS[cand[a]]) if (rel.fwd[d] & cand[b]) na |= bit(d);
            for (const d of DIGITS[cand[b]]) if (rel.rev[d] & cand[a]) nb |= bit(d);
            if (!na || !nb) return -1;
            if (na !== cand[a] || nb !== cand[b]) { cand[a] = na; cand[b] = nb; changed = again = 1; }
        }
    }
    return changed;
}

const GROUP_NODE_LIMIT = 200000;

function applyGroup(c, cand) {
    const cells = c.cells, k = cells.length;
    const lists = cells.map(i => DIGITS[cand[i]]);
    if (lists.some(l => !l.length)) return -1;
    const vals = new Int8Array(k), sup = new Uint16Array(k);
    const distinct = [...Array(k)].map((_, i) => [...Array(i)].map((_, j) => j)
        .filter(j => c.distinct || SEES[cells[i] * 81 + cells[j]]));
    // Bounds on what the remaining cells can still add.
    const minRest = new Int16Array(k + 1), maxRest = new Int16Array(k + 1);
    for (let i = k - 1; i >= 0; i--) {
        minRest[i] = minRest[i + 1] + lists[i][0];
        maxRest[i] = maxRest[i + 1] + lists[i][lists[i].length - 1];
    }
    let nodes = 0, full = false;
    const isArrow = c.type === 'arrow', isRen = c.type === 'renban';
    function dfs(i, sum, lo, hi) {
        if (full || ++nodes > GROUP_NODE_LIMIT) return;
        if (i === k) {
            if (c.type === 'killer' && sum !== c.sum) return;
            if (isArrow && sum !== vals[0]) return;
            if (isRen && hi - lo !== k - 1) return;
            let done = true;
            for (let j = 0; j < k; j++) { sup[j] |= bit(vals[j]); if (sup[j] !== cand[cells[j]]) done = false; }
            if (done) full = true;
            return;
        }
        outer: for (const d of lists[i]) {
            for (const j of distinct[i]) if (vals[j] === d) continue outer;
            let s = sum, l = lo, h = hi;
            if (isArrow) { if (i > 0) s += d; } else s += d;
            if (c.type === 'killer' && (s + minRest[i + 1] > c.sum || s + maxRest[i + 1] < c.sum)) continue;
            if (isArrow && i > 0 && (s + minRest[i + 1] > vals[0] || s + maxRest[i + 1] < vals[0])) continue;
            if (isArrow && i === 0 && (minRest[1] > d || maxRest[1] < d)) continue;
            if (isRen) { l = Math.min(l, d); h = Math.max(h, d); if (h - l > k - 1) continue; }
            vals[i] = d;
            dfs(i + 1, s, l, h);
            vals[i] = 0;
        }
    }
    dfs(0, 0, 10, 0);
    if (nodes > GROUP_NODE_LIMIT) return 0; // too big to reason about safely; skip
    let changed = 0;
    for (let j = 0; j < k; j++) {
        if (!sup[j]) return -1;
        if (sup[j] !== cand[cells[j]]) { cand[cells[j]] = sup[j]; changed = 1; }
    }
    return changed;
}

const applyCon = (c, cand) => (c.kind === 'chain' ? applyChain(c, cand) : applyGroup(c, cand));

// ------------------------------------------------------------------ brute-force solver

function propagate(model, cand) {
    const done = new Uint8Array(81);
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < 81; i++) {
            if (done[i] || POP[cand[i]] !== 1) continue;
            done[i] = 1;
            const m = cand[i];
            for (const p of PEERS[i]) {
                if (cand[p] & m) {
                    cand[p] &= ~m;
                    if (!cand[p]) return false;
                    changed = true;
                }
            }
        }
        for (const h of HOUSES) {
            for (let d = 1; d <= 9; d++) {
                let pos = -1, n = 0;
                for (const i of h) if (cand[i] & bit(d)) { pos = i; n++; }
                if (!n) return false;
                if (n === 1 && cand[pos] !== bit(d)) { cand[pos] = bit(d); changed = true; }
            }
        }
        for (const c of model.cons) {
            const r = applyCon(c, cand);
            if (r < 0) return false;
            if (r) changed = true;
        }
    }
    return true;
}

function initialCands(givens) {
    const cand = new Uint16Array(81);
    for (let i = 0; i < 81; i++) cand[i] = givens[i] ? bit(givens[i]) : ALL;
    return cand;
}

// Counts solutions up to `limit`; optionally randomises branch order and
// returns the first solution found.
function search(model, cand, limit, r, out) {
    if (!propagate(model, cand)) return 0;
    let best = -1, bestN = 10;
    for (let i = 0; i < 81; i++) {
        const n = POP[cand[i]];
        if (n > 1 && n < bestN) { best = i; bestN = n; }
    }
    if (best < 0) {
        if (out && !out.solution) out.solution = Array.from(cand, m => lowDigit(m));
        return 1;
    }
    let count = 0;
    const ds = DIGITS[cand[best]].slice();
    if (r) shuffle(r, ds);
    for (const d of ds) {
        const next = cand.slice();
        next[best] = bit(d);
        count += search(model, next, limit - count, r, out);
        if (count >= limit) break;
    }
    return count;
}

function countSolutions(def, limit) {
    const model = compile(def);
    return search(model, initialCands(def.givens), limit || 2, null, null);
}

function randomGrid(r) {
    const out = {};
    search({ cons: [] }, initialCands(new Array(81).fill(0)), 1, r, out);
    return out.solution;
}

// ------------------------------------------------------------------ human-style solver

// Solves step by step with techniques a person would use, in order of
// difficulty. Used to grade generated puzzles (it must finish) and for hints.
function logicalSolve(model, startDigits, opts) {
    opts = opts || {};
    const cand = new Uint16Array(81).fill(ALL);
    const placed = new Uint8Array(81);
    const steps = [];
    const counts = { single: 0, hidden: 0, constraint: 0, locked: 0, subset: 0, assisted: 0, deep: 0 };
    const record = opts.record;

    function place(i, d) {
        placed[i] = d;
        cand[i] = bit(d);
        for (const p of PEERS[i]) cand[p] &= ~bit(d);
    }
    for (let i = 0; i < 81; i++) if (startDigits[i]) place(i, startDigits[i]);
    for (let i = 0; i < 81; i++) if (startDigits[i] && !(cand[i] & bit(startDigits[i]))) return { solved: false, broken: true, steps, counts };

    const snapshot = () => cand.slice();
    const diff = before => {
        const el = [];
        for (let i = 0; i < 81; i++) if (before[i] !== cand[i]) el.push([i, before[i] & ~cand[i]]);
        return el;
    };

    // With opts.sweeps, nothing is remembered between placements: after each
    // digit goes in, candidates start again from the placed digits alone, and
    // the next digit must follow within that many rounds of looking at the
    // constraints. That keeps every step something you can see on the board,
    // with no long trail of pencil marks behind it.
    const fresh = opts.sweeps > 0;
    let sweeps = 0;
    function reset() {
        for (let i = 0; i < 81; i++) {
            if (placed[i]) { cand[i] = bit(placed[i]); continue; }
            let m = ALL;
            for (const p of PEERS[i]) if (placed[p]) m &= ~bit(placed[p]);
            cand[i] = m;
        }
        sweeps = 0;
    }
    // How much looking the placement just made needed.
    function tally() {
        if (sweeps > 0) counts.assisted++;
        if (sweeps > 1) counts.deep++;
        sweeps = 0;
    }

    let remaining = 81 - startDigits.filter(Boolean).length;
    let guard = 0;
    while (remaining > 0 && guard++ < 2000) {
        if (cand.some(m => !m)) return { solved: false, broken: true, steps, counts, cand, placed };
        let progress = false;
        if (fresh && sweeps === 0) reset();

        // 1. naked single
        for (let i = 0; i < 81 && !progress; i++) {
            if (!placed[i] && POP[cand[i]] === 1) {
                const d = lowDigit(cand[i]);
                place(i, d); remaining--; counts.single++; progress = true;
                if (record) steps.push({ tech: 'single', place: [i, d], cells: [i],
                    text: cellName(i) + ' can only be ' + d + ' - every other digit is ruled out.' });
            }
        }
        if (progress) { tally(); if (opts.stopAtPlacement) break; continue; }

        // 2. hidden single
        for (let h = 0; h < 27 && !progress; h++) {
            for (let d = 1; d <= 9 && !progress; d++) {
                let pos = -1, n = 0, have = false;
                for (const i of HOUSES[h]) {
                    if (placed[i] === d) { have = true; break; }
                    if (!placed[i] && cand[i] & bit(d)) { pos = i; n++; }
                }
                if (!have && n === 1) {
                    place(pos, d); remaining--; counts.hidden++; progress = true;
                    if (record) steps.push({ tech: 'hidden', place: [pos, d], cells: HOUSES[h], house: h,
                        text: 'In ' + houseName(h) + ', ' + d + ' can only go in ' + cellName(pos) + '.' });
                }
            }
        }
        if (progress) { tally(); if (opts.stopAtPlacement) break; continue; }

        if (fresh) {
            if (sweeps >= opts.sweeps || !sweep()) break;
            sweeps++;
            continue;
        }

        // 3. variant constraints
        for (const c of model.cons) {
            const before = snapshot();
            const res = applyCon(c, cand);
            if (res < 0) return { solved: false, broken: true, steps, counts, cand, placed };
            if (res > 0) {
                counts.constraint++; progress = true;
                if (record) steps.push({ tech: 'constraint', con: c, cells: c.cells, elims: diff(before), before, after: snapshot(), placed: placed.slice(),
                    text: 'Look at ' + c.label + ': ' + describeConstraint(c, cand) });
                break;
            }
        }
        if (progress) continue;

        // 4. locked candidates (pointing / claiming)
        for (let h = 0; h < 27 && !progress; h++) {
            for (let d = 1; d <= 9 && !progress; d++) {
                const pos = HOUSES[h].filter(i => !placed[i] && cand[i] & bit(d));
                if (pos.length < 2) continue;
                for (let h2 = 0; h2 < 27 && !progress; h2++) {
                    if (h2 === h || (h < 18) === (h2 < 18)) continue; // box vs line only
                    if (!pos.every(i => HOUSES_OF[i].includes(h2))) continue;
                    const before = snapshot();
                    for (const i of HOUSES[h2]) if (!pos.includes(i) && !placed[i]) cand[i] &= ~bit(d);
                    const el = diff(before);
                    if (el.length) {
                        counts.locked++; progress = true;
                        if (record) steps.push({ tech: 'locked', cells: pos, elims: el, digit: d, house: h, line: h2,
                            text: 'In ' + houseName(h) + ', ' + d + ' must be in ' + houseName(h2) + ', so it can\'t go anywhere else in ' + houseName(h2) + '.' });
                    }
                }
            }
        }
        if (progress) continue;

        // 5. naked pairs and triples
        for (let h = 0; h < 27 && !progress; h++) {
            const open = HOUSES[h].filter(i => !placed[i]);
            for (const size of [2, 3]) {
                if (progress) break;
                const combos = [];
                const rec = (start, chosen) => {
                    if (chosen.length === size) { combos.push(chosen.slice()); return; }
                    for (let x = start; x < open.length; x++) { chosen.push(open[x]); rec(x + 1, chosen); chosen.pop(); }
                };
                rec(0, []);
                for (const combo of combos) {
                    let u = 0;
                    for (const i of combo) u |= cand[i];
                    if (POP[u] !== size) continue;
                    const before = snapshot();
                    for (const i of open) if (!combo.includes(i)) cand[i] &= ~u;
                    const el = diff(before);
                    if (el.length) {
                        counts.subset++; progress = true;
                        if (record) steps.push({ tech: 'subset', cells: combo, elims: el, house: h, mask: u,
                            text: 'In ' + houseName(h) + ', ' + combo.map(cellName).join(', ') + ' can only hold ' +
                                DIGITS[u].join(', ') + ', so those digits can\'t go anywhere else there.' });
                        break;
                    }
                }
            }
        }
        if (!progress) break;
    }
    return { solved: remaining === 0, stuck: remaining > 0, steps, counts, cand, placed };

    // One round: every constraint, and every pointing/claiming pattern, is
    // read against the candidates as they stood at the start of the round,
    // so a round never chains one deduction into the next.
    function sweep() {
        const base = snapshot();
        const next = base.slice();
        let any = false;
        for (const c of model.cons) {
            const read = readConstraint(c, base, placed);
            if (!read) continue;
            const tmp = base.slice();
            for (const [i, m] of read.allowed) tmp[i] &= m;
            if (tmp.some(m => !m)) { cand.fill(0); return true; }
            if (tmp.every((m, i) => m === base[i])) continue;
            const elims = [];
            for (let i = 0; i < 81; i++) if (tmp[i] !== base[i]) { elims.push([i, base[i] & ~tmp[i]]); next[i] &= tmp[i]; }
            counts.constraint++; any = true;
            if (record) steps.push({ tech: 'constraint', con: c, cells: c.cells, elims, before: base, after: tmp, placed: placed.slice(),
                explain: read.explain, text: 'Look at ' + c.label + '.' });
        }
        for (let h = 0; h < 27; h++) {
            for (let d = 1; d <= 9; d++) {
                const pos = HOUSES[h].filter(i => !placed[i] && base[i] & bit(d));
                if (pos.length < 2) continue;
                for (let h2 = 0; h2 < 27; h2++) {
                    if (h2 === h || (h < 18) === (h2 < 18)) continue;
                    if (!pos.every(i => HOUSES_OF[i].includes(h2))) continue;
                    const elims = [];
                    for (const i of HOUSES[h2]) {
                        if (!pos.includes(i) && !placed[i] && base[i] & bit(d)) { elims.push([i, bit(d)]); next[i] &= ~bit(d); }
                    }
                    if (!elims.length) continue;
                    counts.locked++; any = true;
                    if (record) steps.push({ tech: 'locked', cells: pos, elims, digit: d, house: h, line: h2,
                        text: 'In ' + houseName(h) + ', ' + d + ' must be in ' + houseName(h2) + ', so it can\'t go anywhere else in ' + houseName(h2) + '.' });
                }
            }
        }
        for (let i = 0; i < 81; i++) cand[i] = next[i];
        return any;
    }
}

function describeConstraint(c, cand) {
    const opts = c.cells.map(i => DIGITS[cand[i]]);
    if (c.type === 'killer') {
        const ds = new Set(); opts.forEach(o => o.forEach(d => ds.add(d)));
        return 'its ' + c.cells.length + ' digits must add up to ' + c.sum + ', which only works with ' + [...ds].sort().join(', ') + ' here.';
    }
    if (c.type === 'thermo') return 'each digit must be bigger than the one before it, which limits how small or big each cell can be.';
    if (c.type === 'arrow') return 'the circle must equal the sum of the arrow, which rules some digits out.';
    if (c.type === 'renban') return 'the digits must form a run of consecutive numbers, which rules some digits out.';
    if (c.type === 'whispers') return 'neighbours must differ by at least 5, so a 5 can never go on the line and some digits are ruled out.';
    if (c.type === 'kropki') return c.label.includes('white') ? 'the two digits must be consecutive.' : 'one digit must be double the other.';
    if (c.type === 'xv') return c.label.includes('X') ? 'the two digits must add up to 10.' : 'the two digits must add up to 5.';
    return 'it rules some digits out.';
}

// ------------------------------------------------------------------ hints

// userDigits: 81 numbers (0 = empty), including givens.
function hint(def, userDigits) {
    const sol = def.solution;
    const wrong = [];
    for (let i = 0; i < 81; i++) if (userDigits[i] && userDigits[i] !== sol[i]) wrong.push(i);
    if (wrong.length) {
        return { kind: 'mistake', cells: wrong,
            text: wrong.length === 1 ? 'One of your digits is wrong.' : wrong.length + ' of your digits are wrong.' };
    }
    const model = compile(def);
    // Prefer the next digit that needs the least looking. If nothing simple
    // works, hand over a digit rather than explain a deep chain.
    let res = null;
    for (const sweeps of [1, 2, 3]) {
        res = logicalSolve(model, userDigits, { record: true, stopAtPlacement: true, sweeps });
        if (res.steps.some(s => s.place)) break;
    }

    const placeStep = res.steps.find(s => s.place);
    if (!placeStep) {
        const empty = [];
        for (let i = 0; i < 81; i++) if (!userDigits[i]) empty.push(i);
        if (!empty.length) return { kind: 'done', text: 'The grid is full and correct.' };
        const i = empty[(Math.random() * empty.length) | 0];
        return { kind: 'place', cell: i, digit: sol[i], cells: [i], helpers: [],
            text: 'Nothing simple leads on from here, so here\'s a free digit.' };
    }
    const [cell, digit] = placeStep.place;
    const placed = Uint8Array.from(userDigits);
    if (placeStep.tech === 'hidden') {
        return { kind: 'place', cell, digit, cells: placeStep.cells,
            text: 'In ' + houseName(placeStep.house) + ', the ' + digit + ' can only go in ' + cellName(cell) + '. Every other cell is ruled out:',
            helpers: explainHidden(placeStep.house, digit, cell, res.steps, placed) };
    }
    return { kind: 'place', cell, digit, cells: [cell],
        text: cellName(cell) + ' must be ' + digit + '. Every other digit is ruled out:',
        helpers: explainSingle(cell, digit, res.steps, placed) };
}

// ------------------------------------------------------------------ hint explanations
//
// A hint names every digit (or cell) that is ruled out and says exactly
// what rules it out: a digit already in the row, column or box, or the
// specific cage, line, dot or pattern that removed it.

const list = (xs, word) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' ' + (word || 'and') + ' ' + xs[xs.length - 1];
const cellList = cells => list(cells.map(cellName));
const cap = t => (/^r\dc\d/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1));
const aDigit = d => (d === 8 ? 'an ' : 'a ') + d;

function sharedHouse(a, b) {
    if (rowOf(a) === rowOf(b)) return rowOf(a);
    if (colOf(a) === colOf(b)) return 9 + colOf(a);
    return 18 + boxOf(a);
}

// Covers `items` with as few houses as possible; housesOf(item) lists the
// houses that explain it. Returns [[house, items], ...] plus the leftovers.
function groupByHouse(items, housesOf) {
    const opts = items.map(housesOf);
    const left = new Set(items.filter((_, k) => opts[k].length));
    const groups = [];
    while (left.size) {
        const count = new Map();
        items.forEach((x, k) => { if (left.has(x)) new Set(opts[k]).forEach(h => count.set(h, (count.get(h) || 0) + 1)); });
        const h = [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
        const got = items.filter((x, k) => left.has(x) && opts[k].includes(h));
        got.forEach(x => left.delete(x));
        groups.push([h, got]);
    }
    return { groups, rest: items.filter((_, k) => !opts[k].length) };
}

// A short name for what a step is, for "(ruled out by ...)".
function stepLabel(step) {
    if (!step) return 'the other hint steps';
    if (step.tech === 'constraint') return step.con.label;
    if (step.tech === 'locked') return 'the ' + step.digit + ' in ' + houseName(step.house) + ' being stuck in ' + houseName(step.line);
    if (step.tech === 'subset') return 'the ' + list(DIGITS[step.mask].map(String)) + ' in ' + cellList(step.cells);
    return 'the other hint steps';
}

// Why each of `cells` can't hold `d`: a placed digit it sees, or the step
// that removed it.
function blockedPhrase(cells, d, placed, steps) {
    const filled = cells.filter(i => placed[i]);
    cells = cells.filter(i => !placed[i]);
    const { groups, rest } = groupByHouse(cells, i => PEERS[i].filter(p => placed[p] === d).map(p => sharedHouse(i, p)));
    const parts = groups.map(([h, cs]) => cellList(cs) + ' (' + houseName(h) + ' already has ' + aDigit(d) + ')');
    const byStep = new Map();
    for (const i of rest) {
        const label = stepLabel(remover(steps || [], i, d));
        if (!byStep.has(label)) byStep.set(label, []);
        byStep.get(label).push(i);
    }
    for (const [label, cs] of byStep) parts.push(cellList(cs) + ' (ruled out by ' + label + ')');
    for (const i of filled) parts.push(cellName(i) + ' (already ' + placed[i] + ')');
    return list(parts);
}

function opts(i, cand) {
    return list(DIGITS[cand[i]].map(String), 'or');
}

// Every way to fill a group constraint's cells from `cand`, up to `limit`.
function groupFillings(c, cand, limit) {
    const cells = c.cells, k = cells.length, vals = new Array(k), out = [];
    function ok() {
        if (c.type === 'killer') return vals.reduce((a, b) => a + b, 0) === c.sum;
        if (c.type === 'arrow') return vals.slice(1).reduce((a, b) => a + b, 0) === vals[0];
        if (c.type === 'renban') return Math.max(...vals) - Math.min(...vals) === k - 1;
        return true;
    }
    (function dfs(j) {
        if (out.length > limit) return;
        if (j === k) { if (ok()) out.push(vals.slice()); return; }
        for (const d of DIGITS[cand[cells[j]]]) {
            let clash = false;
            for (let q = 0; q < j; q++) if (vals[q] === d && (c.distinct || SEES[cells[q] * 81 + cells[j]])) { clash = true; break; }
            if (clash) continue;
            vals[j] = d;
            dfs(j + 1);
        }
    })(0);
    return out;
}

function digitSets(k, sum) {
    const out = [];
    (function rec(start, chosen, s) {
        if (chosen.length === k) { if (s === sum) out.push(chosen.slice()); return; }
        for (let d = start; d <= 9 && s + d <= sum; d++) { chosen.push(d); rec(d + 1, chosen, s + d); chosen.pop(); }
    })(1, [], 0);
    return out;
}

const plus = set => set.join('+');

function explainKiller(c, step, target, xs) {
    const { before, placed } = step;
    const k = c.cells.length, others = c.cells.filter(i => i !== target);
    const fillings = groupFillings(c, before, 5000);
    const fitKeys = new Set(fillings.map(f => f.slice().sort((a, b) => a - b).join('+')));
    const sets = digitSets(k, c.sum);
    const fitting = sets.filter(st => fitKeys.has(plus(st)));
    const at = new Set(fillings.map(f => f[c.cells.indexOf(target)]));
    const parts = [];
    if (sets.length <= 8) {
        parts.push('The ' + c.sum + ' cage (' + cellList(c.cells) + ') needs ' + k + ' different digits adding up to ' + c.sum +
            ': ' + list(sets.map(plus), 'or') + '.');
        const out = sets.filter(st => !fitKeys.has(plus(st)));
        const missing = new Map(), odd = [];
        for (const st of out) {
            const d = st.find(x => c.cells.every(i => !(before[i] & bit(x))));
            if (d) { if (!missing.has(d)) missing.set(d, []); missing.get(d).push(st); } else odd.push(st);
        }
        for (const [d, sts] of missing) {
            parts.push('None of its cells can be ' + aDigit(d) + ' - ' + blockedPhrase(c.cells, d, placed, step.steps) + ' - which rules out ' + list(sts.map(plus), 'and') + '.');
        }
        if (odd.length) {
            parts.push(cap(list(odd.map(plus), 'and')) + ' can\'t be fitted into the cells (' +
                c.cells.map(i => cellName(i) + (placed[i] ? ' is ' + placed[i] : ' can be ' + opts(i, before))).join('; ') + ').');
        }
        if (fitting.length && out.length) parts.push((fitting.length === 1 ? 'That leaves only ' : 'That leaves ') + list(fitting.map(plus), 'or') + '.');
    } else if (fitting.length && fitting.length <= 6) {
        parts.push('With what its cells can still hold, the ' + c.sum + ' cage can only be ' + list(fitting.map(plus), 'or') + '.');
    } else {
        parts.push('In the ' + c.sum + ' cage, ' + others.map(i => cellName(i) + (placed[i] ? ' is ' + placed[i] : ' can be ' + opts(i, before))).join('; ') + '.');
    }
    const d = at.size === 1 ? [...at][0] : 0;
    if (d && fitting.length && fitting.every(st => st.includes(d)) && others.every(i => !(before[i] & bit(d)))) {
        parts.push((fitting.length === 1 ? 'It' : fitting.length === 2 ? 'Both' : 'All of them') + ' need' + (fitting.length === 1 ? 's ' : ' ') + aDigit(d) +
            ', and ' + cellName(target) + ' is the only cell in the cage that can take it: ' + blockedPhrase(others, d, placed, step.steps) + ' can\'t.');
        return parts.join('\n') + '\nSo ' + cellName(target) + ' can\'t be ' + list(xs.map(String), 'or') + '.';
    }
    const used = new Set(fitting.flat());
    const unused = xs.filter(x => !used.has(x)), left = xs.filter(x => used.has(x));
    if (unused.length && fitting.length && fitting.length <= 6) parts.push('None of those use ' + list(unused.map(String), 'or') + '.');
    if (left.length || !fitting.length || fitting.length > 6) {
        const bad = fitting.length && fitting.length <= 6 ? left : xs;
        if (bad.length) parts.push('With ' + list(bad.map(String), 'or') + ' in ' + cellName(target) + ', the other cells (' +
            others.map(i => cellName(i) + ': ' + (placed[i] ? 'is ' + placed[i] : opts(i, before))).join('; ') + ') can\'t make up the rest of the ' + c.sum + '.');
    }
    return parts.join('\n') + '\nSo ' + cellName(target) + ' can\'t be ' + list(xs.map(String), 'or') + '.';
}

function explainGroup(c, step, target, xs) {
    const { before } = step;
    const others = c.cells.filter(i => i !== target);
    const rule = c.type === 'arrow' ? 'the circle must equal the sum of the digits on the arrow'
        : 'the line must hold a set of consecutive digits, in any order';
    const fillings = groupFillings(c, before, 6);
    let text = 'On ' + c.label + ', ' + rule + '. ';
    if (c.type === 'renban') {
        // Every digit on the line is within k-1 of every other one, so the
        // tightest cell bounds the whole line.
        const k = c.cells.length;
        let best = null;
        for (const i of others) {
            const ds = DIGITS[before[i]], lo = ds[ds.length - 1] - (k - 1), hi = ds[0] + (k - 1);
            if (!best || hi - lo < best.hi - best.lo) best = { i, lo: Math.max(1, lo), hi: Math.min(9, hi), ds };
        }
        if (best && xs.every(x => x < best.lo || x > best.hi)) {
            return 'On ' + c.label + ', the ' + k + ' digits must be consecutive, so they all lie within ' + (k - 1) + ' of each other. ' +
                cellName(best.i) + (best.ds.length === 1 ? ' is ' + best.ds[0] : ' can only be ' + opts(best.i, before)) +
                ', so every digit on the line is between ' + best.lo + ' and ' + best.hi + '.\nSo ' + cellName(target) + ' can\'t be ' + list(xs.map(String), 'or') + '.';
        }
    }
    if (fillings.length && fillings.length <= 4) {
        text += 'With what its cells can still hold, the only way' + (fillings.length > 1 ? 's' : '') + ' to fill it ' +
            (fillings.length > 1 ? 'are ' : 'is ') + list(fillings.map(f => '(' + f.join(', ') + ')'), 'or') +
            ' for ' + cellList(c.cells) + '.';
    } else {
        text += 'The other cells can only be: ' + others.map(i => cellName(i) + ' ' + opts(i, before)).join('; ') +
            '. There\'s no way to complete it with ' + list(xs.map(String), 'or') + ' in ' + cellName(target) + '.';
    }
    return text + ' So ' + cellName(target) + ' can\'t be ' + list(xs.map(String), 'or') + '.';
}

function explainChain(c, step, target, xs) {
    // A lone dot only needs what the neighbour could hold from the board;
    // along a longer line the rest of the line narrows it first.
    const after = c.cells.length === 2 ? step.before : step.after;
    const at = c.cells.indexOf(target);
    const prev = at > 0 ? c.cells[at - 1] : -1, next = at < c.cells.length - 1 ? c.cells[at + 1] : -1;
    const byNb = new Map();
    const lonely = [];
    for (const x of xs) {
        // Some digits have no partner at all on this kind of line or dot.
        if (c.type !== 'thermo' && [at > 0 ? c.links[at - 1].rev[x] : 0, at < c.links.length ? c.links[at].fwd[x] : 0]
            .every((m, k) => !(k ? at < c.links.length : at > 0) || !m)) { lonely.push(x); continue; }
        let nb = -1;
        if (prev >= 0 && !(c.links[at - 1].rev[x] & after[prev])) nb = prev;
        else if (next >= 0 && !(c.links[at].fwd[x] & after[next])) nb = next;
        if (!byNb.has(nb)) byNb.set(nb, []);
        byNb.get(nb).push(x);
    }
    const parts = [];
    if (lonely.length) {
        const ls = list(lonely.map(String), 'or');
        const why = { kropki: 'no digit is half or double ' + ls, xv: 'no digit adds up to 5 with ' + ls,
            whispers: 'no digit differs by 5 or more from ' + ls }[c.type] || ls + ' can\'t go there';
        parts.push(cellName(target) + ' is on ' + c.label + ', and ' + why + '. So ' + cellName(target) + ' can\'t be ' + ls + '.');
    }
    for (const [nb, ds] of byNb) {
        const no = cellName(target) + ' can\'t be ' + list(ds.map(String), 'or');
        if (nb < 0) { parts.push(no + ' because of ' + c.label + '.'); continue; }
        const nbOpts = DIGITS[after[nb]], n = cellName(nb);
        let why;
        if (c.type === 'thermo') {
            why = nb === prev
                ? 'it must be bigger than ' + n + ', which is at least ' + nbOpts[0]
                : 'it must be smaller than ' + n + ', which is at most ' + nbOpts[nbOpts.length - 1];
        } else {
            const rel = { whispers: 'differ by at least 5 from', kropki: c.label.includes('white') ? 'be one more or one less than' : 'be half or double',
                xv: c.label.includes('X') ? 'add up to 10 with' : 'add up to 5 with' }[c.type] || 'match';
            why = 'it must ' + rel + ' ' + n + ', which can only be ' + list(nbOpts.map(String), 'or');
        }
        parts.push(no + ': on ' + c.label + ', ' + why + '.');
    }
    return parts.join('\n');
}

// ------------------------------------------------------------------ reading constraints at a glance
//
// What a person can see straight off the board: the last cell of a cage,
// a two-cell cage as a pair, the well-known cages (1+2+3, 7+8+9), digits
// next to a placed digit on a line or dot, and so on. Never a search
// through combinations. Each reader returns { allowed: Map(cell -> mask),
// explain(cell, digits) } or null when there's nothing to see.

const NEAR_LIMIT = 3; // a neighbour counts if it's placed or down to this many options

const so = (cells, xs) => '\nSo ' + cellList([].concat(cells)) + ' can\'t be ' + list(xs.map(String), 'or') + '.';
const maskOf = ds => ds.reduce((m, d) => m | bit(d), 0);
const range = (lo, hi) => { const ds = []; for (let d = Math.max(1, lo); d <= Math.min(9, hi); d++) ds.push(d); return ds; };
const digitsText = ds => list(ds.map(String));

// Why cell p can't be e, if a placed digit shows it.
function seenBy(p, e, placed) {
    const q = PEERS[p].find(x => placed[x] === e);
    return q != null ? ' (' + houseName(sharedHouse(p, q)) + ' already has ' + aDigit(e) + ')' : '';
}

function readKiller(c, base, placed) {
    const open = c.cells.filter(i => !placed[i]), filled = c.cells.filter(i => placed[i]);
    if (!open.length) return null;
    let used = 0, got = 0;
    filled.forEach(i => { used |= bit(placed[i]); got += placed[i]; });
    const rem = c.sum - got, n = open.length;
    const name = 'The ' + c.sum + ' cage at ' + cellName(Math.min(...c.cells));
    const has = filled.length ? name + ' already has ' + digitsText(filled.map(i => placed[i])) + ', so ' : name + ' is ' + cellList(open) + ', so ';
    const allowed = new Map();

    if (n === 1) {
        const t = open[0];
        allowed.set(t, rem >= 1 && rem <= 9 && !(used & bit(rem)) ? bit(rem) : 0);
        return { allowed, explain: (_, xs) => has + cellName(t) + ' must make up the remaining ' + rem + '.' + so(t, xs) };
    }

    if (n === 2) {
        const why = new Map();
        for (const [t, p] of [[open[0], open[1]], [open[1], open[0]]]) {
            let m = 0;
            const reasons = new Map();
            for (const d of DIGITS[base[t]]) {
                const e = rem - d;
                let r = null;
                if (e < 1) r = 'leaves nothing for ' + cellName(p);
                else if (e > 9) r = 'would need ' + cellName(p) + ' to be more than 9';
                else if (e === d) r = 'would need a second ' + d + ' in ' + cellName(p);
                else if (used & bit(e)) r = 'would need ' + cellName(p) + ' to be ' + e + ', which is already in the cage';
                else if (!(base[p] & bit(e))) r = 'would need ' + cellName(p) + ' to be ' + e + ', and it can\'t be' + seenBy(p, e, placed);
                if (!r) m |= bit(d); else reasons.set(d, r);
            }
            allowed.set(t, m);
            why.set(t, reasons);
        }
        return { allowed, explain: (t, xs) => {
            const lines = xs.map(x => cap(cellName(t)) + ' = ' + x + ' ' + (why.get(t).get(x) || 'doesn\'t fit') + '.');
            return has + cellList(open) + ' add up to ' + rem + '.\n' + lines.join('\n') + so(t, xs);
        } };
    }

    // Three or more open cells: only the famous totals, the smallest or
    // biggest sums those cells can make, or one off from them.
    if (used) return null;
    const low = range(1, n), high = range(10 - n, 9);
    const lowSum = low.reduce((a, b) => a + b, 0), highSum = high.reduce((a, b) => a + b, 0);
    let set = null, why = '';
    if (rem === lowSum) { set = low; why = 'the smallest ' + n + ' different digits can make is ' + low.join('+') + ' = ' + rem; }
    else if (rem === lowSum + 1) { set = low.slice(0, -1).concat(n + 1); why = rem + ' is one more than the smallest possible (' + low.join('+') + ' = ' + lowSum + '), which only works as ' + set.join('+'); }
    else if (rem === highSum) { set = high; why = 'the biggest ' + n + ' different digits can make is ' + high.join('+') + ' = ' + rem; }
    else if (rem === highSum - 1) { set = [9 - n].concat(high.slice(1)); why = rem + ' is one less than the biggest possible (' + high.join('+') + ' = ' + highSum + '), which only works as ' + set.join('+'); }
    if (!set) return null;
    const m = maskOf(set);
    open.forEach(i => allowed.set(i, m));
    return { allowed, explain: (t, xs) => name + ' has ' + n + ' cells adding up to ' + rem + ', and ' + why + '.' + so(t, xs) };
}

function readArrow(c, placed) {
    const [circ, ...path] = c.cells;
    const open = path.filter(i => !placed[i]);
    const got = path.filter(i => placed[i]).reduce((s, i) => s + placed[i], 0);
    const head = 'On ' + c.label + ', the circle equals the sum of the arrow' + (got ? ' (the placed arrow digits add up to ' + got + ')' : '') + '. ';
    const allowed = new Map();
    if (placed[circ]) {
        if (!open.length) return null;
        const rem = placed[circ] - got;
        if (open.length === 1) {
            allowed.set(open[0], rem >= 1 && rem <= 9 ? bit(rem) : 0);
            return { allowed, explain: (t, xs) => head + 'The circle is ' + placed[circ] + ', so ' + cellName(t) + ' must be ' + rem + '.' + so(t, xs) };
        }
        const max = rem - (open.length - 1);
        open.forEach(i => allowed.set(i, maskOf(range(1, max))));
        return { allowed, explain: (t, xs) => head + 'The circle is ' + placed[circ] + ', so the ' + open.length + ' empty arrow cells share ' + rem +
            '. Each of them is at least 1, so none can be more than ' + max + '.' + so(t, xs) };
    }
    if (!open.length) {
        allowed.set(circ, got <= 9 ? bit(got) : 0);
        return { allowed, explain: (t, xs) => head + 'The arrow is full, so the circle must be ' + got + '.' + so(t, xs) };
    }
    const min = got + open.length;
    allowed.set(circ, maskOf(range(min, 9)));
    return { allowed, explain: (t, xs) => head + 'Each empty arrow cell is at least 1, so the circle is at least ' + min + '.' + so(t, xs) };
}

function readRenban(c, placed) {
    const P = c.cells.filter(i => placed[i]).map(i => placed[i]);
    const open = c.cells.filter(i => !placed[i]);
    if (!P.length || !open.length) return null;
    const k = c.cells.length, lo = Math.max(...P) - (k - 1), hi = Math.min(...P) + (k - 1);
    const m = maskOf(range(lo, hi)) & ~maskOf(P);
    const allowed = new Map();
    open.forEach(i => allowed.set(i, m));
    return { allowed, explain: (t, xs) => 'On ' + c.label + ', the ' + k + ' digits are consecutive and don\'t repeat. It already has ' + digitsText(P) +
        ', so every digit on it is between ' + Math.max(1, lo) + ' and ' + Math.min(9, hi) + '.' + so(t, xs) };
}

function readThermo(c, placed) {
    const cells = c.cells, k = cells.length, allowed = new Map(), info = new Map();
    cells.forEach((t, j) => {
        if (placed[t]) return;
        let low = j + 1, lowWhy = cellName(t) + ' is cell ' + (j + 1) + ' from the bulb, so it\'s at least ' + (j + 1);
        let high = 9 - (k - 1 - j), highWhy = cellName(t) + ' has ' + (k - 1 - j) + ' more cell' + (k - 2 - j ? 's' : '') + ' after it, so it\'s at most ' + high;
        cells.forEach((q, i) => {
            if (!placed[q]) return;
            if (i < j && placed[q] + (j - i) > low) { low = placed[q] + (j - i); lowWhy = cellName(t) + ' comes ' + (j - i) + ' cell' + (j - i > 1 ? 's' : '') + ' after ' + cellName(q) + ' (' + placed[q] + '), so it\'s at least ' + low; }
            if (i > j && placed[q] - (i - j) < high) { high = placed[q] - (i - j); highWhy = cellName(t) + ' comes ' + (i - j) + ' cell' + (i - j > 1 ? 's' : '') + ' before ' + cellName(q) + ' (' + placed[q] + '), so it\'s at most ' + high; }
        });
        allowed.set(t, maskOf(range(low, high)));
        info.set(t, { low, high, lowWhy, highWhy });
    });
    if (!allowed.size) return null;
    return { allowed, explain: (t, xs) => {
        const f = info.get(t), parts = [];
        if (xs.some(x => x < f.low)) parts.push(f.lowWhy + '.');
        if (xs.some(x => x > f.high)) parts.push(f.highWhy + '.');
        return 'On ' + c.label + ', digits increase from the bulb. ' + parts.join(' ') + so(t, xs);
    } };
}

const REL_TEXT = { whispers: 'differ by at least 5 from', white: 'be one more or one less than', black: 'be half or double',
    x: 'add up to 10 with', v: 'add up to 5 with' };
const LONELY_TEXT = { whispers: ls => 'no digit differs by 5 or more from ' + ls, black: ls => 'no digit is half or double ' + ls,
    v: ls => 'no digit adds up to 5 with ' + ls };

function readChain(c, base, placed) {
    const kind = c.type === 'kropki' ? (c.label.includes('white') ? 'white' : 'black') : c.type === 'xv' ? (c.label.includes(' X ') ? 'x' : 'v') : 'whispers';
    const allowed = new Map(), why = new Map();
    c.cells.forEach((t, j) => {
        if (placed[t]) return;
        const links = [];
        if (j > 0) links.push([c.cells[j - 1], c.links[j - 1].rev]);
        if (j < c.links.length) links.push([c.cells[j + 1], c.links[j].fwd]);
        let m = base[t];
        const reasons = new Map();
        for (const d of DIGITS[base[t]]) {
            for (const [nb, rel] of links) {
                if (!rel[d]) { reasons.set(d, { lonely: true }); break; }
                const near = placed[nb] || POP[base[nb]] <= NEAR_LIMIT;
                if (near && !(rel[d] & base[nb])) { reasons.set(d, { nb }); break; }
            }
            if (reasons.has(d)) m &= ~bit(d);
        }
        if (m !== base[t]) { allowed.set(t, m); why.set(t, reasons); }
    });
    if (!allowed.size) return null;
    return { allowed, explain: (t, xs) => {
        const r = why.get(t), parts = [];
        const lonely = xs.filter(x => r.get(x) && r.get(x).lonely);
        if (lonely.length) parts.push(cap(cellName(t)) + ' is on ' + c.label + ', and ' + LONELY_TEXT[kind](list(lonely.map(String), 'or')) + '.');
        const byNb = new Map();
        xs.filter(x => r.get(x) && r.get(x).nb != null).forEach(x => {
            const nb = r.get(x).nb;
            if (!byNb.has(nb)) byNb.set(nb, []);
            byNb.get(nb).push(x);
        });
        for (const [nb, ds] of byNb) {
            const what = placed[nb] ? 'which is ' + placed[nb] : 'which can only be ' + list(DIGITS[base[nb]].map(String), 'or');
            parts.push('On ' + c.label + ', ' + cellName(t) + ' must ' + REL_TEXT[kind] + ' ' + cellName(nb) + ', ' + what + '.');
        }
        return parts.join('\n') + so(t, xs);
    } };
}

function readConstraint(c, base, placed) {
    if (c.type === 'killer') return readKiller(c, base, placed);
    if (c.type === 'arrow') return readArrow(c, placed);
    if (c.type === 'renban') return readRenban(c, placed);
    if (c.type === 'thermo') return readThermo(c, placed);
    return readChain(c, base, placed);
}

// Why `step` removed digits `xs` from `target`.
function explainStep(step, target, xs, steps) {
    if (step.explain) return step.explain(target, xs);
    step.steps = steps.slice(0, steps.indexOf(step));
    if (step.tech === 'constraint') {
        const c = step.con;
        if (c.type === 'killer') return explainKiller(c, step, target, xs);
        if (c.kind === 'group') return explainGroup(c, step, target, xs);
        return explainChain(c, step, target, xs);
    }
    if (step.tech === 'locked') {
        return 'In ' + houseName(step.house) + ', the ' + step.digit + ' has to go in ' + cellList(step.cells) + ', which are all in ' +
            houseName(step.line) + '. So no other cell in ' + houseName(step.line) + ' can be ' + aDigit(step.digit) + ', including ' + cellName(target) + '.';
    }
    if (step.tech === 'subset') {
        const u = DIGITS[step.mask];
        return 'In ' + houseName(step.house) + ', ' + cellList(step.cells) + ' can only hold ' + list(u.map(String)) +
            ' between them, so those digits are used up there and ' + cellName(target) + ' can\'t be ' + list(xs.map(String), 'or') + '.';
    }
    return cellName(target) + ' can\'t be ' + list(xs.map(String), 'or') + '.';
}

const stepCells = (step, target) => step.cells.concat([target]);

// The earliest step that removed digit d from cell i.
function remover(steps, i, d) {
    return steps.find(s => !s.place && (s.elims || []).some(([j, m]) => j === i && m & bit(d)));
}

function explainSingle(cell, digit, steps, placed) {
    const helpers = [];
    const others = DIGITS[ALL & ~bit(digit)];
    const { groups, rest } = groupByHouse(others, x => HOUSES_OF[cell].filter(h => HOUSES[h].some(p => placed[p] === x)));
    if (groups.length) {
        helpers.push({ text: cap(list(groups.map(([h, ds]) => houseName(h) + ' already has ' + list(ds.map(String))))) + '.',
            cells: [].concat(...groups.map(([h]) => HOUSES[h])) });
    }
    const bySteps = new Map(), unknown = [];
    for (const x of rest) {
        const s = remover(steps, cell, x);
        if (!s) { unknown.push(x); continue; }
        if (!bySteps.has(s)) bySteps.set(s, []);
        bySteps.get(s).push(x);
    }
    for (const [s, xs] of bySteps) helpers.push({ text: explainStep(s, cell, xs, steps), cells: stepCells(s, cell) });
    if (unknown.length) helpers.push({ text: cellName(cell) + ' can\'t be ' + list(unknown.map(String), 'or') + '.', cells: [cell] });
    return helpers;
}

// Explanations that differ only in their "So rXcY can't be d." line are
// said once, naming all the cells.
function mergeExplanations(cells, texts, digit) {
    const body = t => t.slice(0, t.lastIndexOf('\n'));
    if (texts.length > 1 && texts.every(t => t.includes('\n') && body(t) === body(texts[0]))) {
        return body(texts[0]) + '\nSo ' + cellList(cells) + ' can\'t be ' + aDigit(digit) + '.';
    }
    return texts.join('\n');
}

function explainHidden(house, digit, cell, steps, placed) {
    const helpers = [];
    const open = HOUSES[house].filter(i => i !== cell && !placed[i]);
    const filled = HOUSES[house].filter(i => i !== cell && placed[i]);
    if (filled.length) helpers.push({ text: cap(cellList(filled)) + (filled.length > 1 ? ' are' : ' is') + ' already filled.', cells: filled });
    const seen = open.filter(i => PEERS[i].some(p => placed[p] === digit));
    if (seen.length) helpers.push({ text: cap(blockedPhrase(seen, digit, placed, steps)) + ' can\'t be ' + aDigit(digit) + '.', cells: seen });
    const bySteps = new Map(), unknown = [];
    for (const i of open.filter(i => !seen.includes(i))) {
        const s = remover(steps, i, digit);
        if (!s) { unknown.push(i); continue; }
        if (!bySteps.has(s)) bySteps.set(s, []);
        bySteps.get(s).push(i);
    }
    for (const [s, cells] of bySteps) {
        const text = s.tech === 'locked'
            ? 'In ' + houseName(s.house) + ', the ' + digit + ' has to go in ' + cellList(s.cells) + ', which are all in ' + houseName(s.line) +
              '. So no other cell in ' + houseName(s.line) + ' can be ' + aDigit(digit) + ', including ' + cellList(cells) + '.'
            : mergeExplanations(cells, cells.map(i => explainStep(s, i, [digit], steps)), digit);
        helpers.push({ text, cells: stepCells(s, cells[0]).concat(cells) });
    }
    if (unknown.length) helpers.push({ text: cap(cellList(unknown)) + ' can\'t be ' + aDigit(digit) + '.', cells: unknown });
    return helpers;
}

// ------------------------------------------------------------------ generator

function walk(r, start, nbrs, len, used, ok) {
    const path = [start];
    while (path.length < len) {
        const cur = path[path.length - 1];
        const opts = nbrs[cur].filter(n => !used[n] && !path.includes(n) && ok(path, n));
        if (!opts.length) break;
        path.push(pick(r, opts));
    }
    return path;
}

const builders = {
    thermo(r, S, used, n) {
        const out = [];
        for (let tries = 0; tries < 400 && out.length < n; tries++) {
            const s = randInt(r, 0, 80);
            if (used[s] || S[s] > 5) continue;
            const p = walk(r, s, NB8, randInt(r, 3, 6), used, (path, x) => S[x] > S[path[path.length - 1]]);
            if (p.length >= 3) { p.forEach(i => (used[i] = 1)); out.push(p); }
        }
        return { thermos: out };
    },
    whispers(r, S, used, n) {
        const out = [];
        for (let tries = 0; tries < 400 && out.length < n; tries++) {
            const s = randInt(r, 0, 80);
            if (used[s] || S[s] === 5) continue;
            const p = walk(r, s, NB8, randInt(r, 3, 7), used, (path, x) => Math.abs(S[x] - S[path[path.length - 1]]) >= 5);
            if (p.length >= 3) { p.forEach(i => (used[i] = 1)); out.push(p); }
        }
        return { whispers: out };
    },
    renban(r, S, used, n) {
        const out = [];
        for (let tries = 0; tries < 2000 && out.length < n; tries++) {
            const s = randInt(r, 0, 80);
            if (used[s]) continue;
            const len = randInt(r, 3, 5);
            const p = walk(r, s, NB8, len, used, (path, x) => {
                const vals = path.map(i => S[i]).concat(S[x]);
                return new Set(vals).size === vals.length && Math.max(...vals) - Math.min(...vals) <= len - 1;
            });
            const vals = p.map(i => S[i]);
            if (p.length >= 3 && Math.max(...vals) - Math.min(...vals) === p.length - 1) { p.forEach(i => (used[i] = 1)); out.push(p); }
        }
        return { renbans: out };
    },
    arrow(r, S, used, n) {
        const out = [];
        for (let tries = 0; tries < 2000 && out.length < n; tries++) {
            const c = randInt(r, 0, 80);
            if (used[c] || S[c] < 3) continue;
            const first = NB8[c].filter(x => !used[x] && S[x] < S[c]);
            if (!first.length) continue;
            const len = randInt(r, 1, 3);
            const p = walk(r, pick(r, first), NB8, len, Object.assign([], used, { [c]: 1 }), (path, x) =>
                path.reduce((s, i) => s + S[i], 0) + S[x] <= S[c] && x !== c);
            const sum = p.reduce((s, i) => s + S[i], 0);
            if (sum === S[c] && (p.length > 1 || r() < 0.3)) {
                used[c] = 1; p.forEach(i => (used[i] = 1));
                out.push({ circle: c, path: p });
            }
        }
        return { arrows: out };
    },
    killer(r, S, used, n) {
        const out = [];
        for (let tries = 0; tries < 800 && out.length < n; tries++) {
            const s = randInt(r, 0, 80);
            if (used[s]) continue;
            const size = randInt(r, 2, 4), cells = [s];
            while (cells.length < size) {
                const opts = [];
                cells.forEach(c => NB4[c].forEach(x => {
                    if (!used[x] && !cells.includes(x) && !opts.includes(x) && !cells.some(y => S[y] === S[x])) opts.push(x);
                }));
                if (!opts.length) break;
                cells.push(pick(r, opts));
            }
            if (cells.length >= 2) {
                cells.forEach(i => (used[i] = 1));
                out.push({ cells: cells.sort((a, b) => a - b), sum: cells.reduce((t, i) => t + S[i], 0) });
            }
        }
        return { cages: out };
    },
    kropki(r, S) {
        const out = [];
        for (let i = 0; i < 81; i++) for (const j of [i + 1, i + 9]) {
            if ((j === i + 1 && colOf(i) === 8) || j > 80) continue;
            const a = S[i], b = S[j];
            const w = Math.abs(a - b) === 1, k = a === 2 * b || b === 2 * a;
            if (w || k) out.push({ a: i, b: j, t: w && k ? pick(r, ['w', 'b']) : w ? 'w' : 'b' });
        }
        return { dots: out };
    },
    xv(r, S) {
        const out = [];
        for (let i = 0; i < 81; i++) for (const j of [i + 1, i + 9]) {
            if ((j === i + 1 && colOf(i) === 8) || j > 80) continue;
            const s = S[i] + S[j];
            if (s === 10 || s === 5) out.push({ a: i, b: j, t: s === 10 ? 'x' : 'v' });
        }
        return { xv: out };
    },
};

const THEMES = [
    { types: ['classic'], w: 1 },
    { types: ['killer'], w: 3, n: { killer: 14 } },
    { types: ['thermo'], w: 3, n: { thermo: 8 } },
    { types: ['arrow'], w: 2, n: { arrow: 7 } },
    { types: ['kropki'], w: 2 },
    { types: ['xv'], w: 2 },
    { types: ['whispers'], w: 2, n: { whispers: 8 } },
    { types: ['renban'], w: 2, n: { renban: 8 } },
    { types: ['killer', 'thermo'], w: 1, n: { killer: 8, thermo: 3 } },
    { types: ['arrow', 'kropki'], w: 1, n: { arrow: 4 } },
    { types: ['renban', 'whispers'], w: 1, n: { renban: 5, whispers: 5 } },
    { types: ['kropki', 'xv'], w: 1 },
    { types: ['killer', 'xv'], w: 1, n: { killer: 8 } },
];

const CON_KEYS = ['cages', 'thermos', 'arrows', 'dots', 'xv', 'whispers', 'renbans'];

function pickTheme(r) {
    const total = THEMES.reduce((s, t) => s + t.w, 0);
    let x = r() * total;
    for (const t of THEMES) { if ((x -= t.w) < 0) return t; }
    return THEMES[0];
}

function generate(opts) {
    opts = opts || {};
    const seed = opts.seed != null ? opts.seed : (Math.random() * 2 ** 32) >>> 0;
    const r = rng(seed);
    for (let attempt = 0; attempt < 30; attempt++) {
        const theme = opts.types ? THEMES.find(t => t.types.join() === opts.types.join()) || { types: opts.types } : pickTheme(r);
        const S = randomGrid(r);
        const def = { seed, types: theme.types.slice(), solution: S };
        CON_KEYS.forEach(k => (def[k] = []));
        const used = new Array(81).fill(0);
        for (const t of theme.types) {
            if (t === 'classic') continue;
            Object.assign(def, builders[t](r, S, used, (theme.n && theme.n[t]) || 0));
        }
        const result = minimise(def, r);
        if (result) {
            result.title = theme.types.map(t => TYPE_NAMES[t]).join(' & ');
            result.rules = theme.types.map(t => RULES[t]);
            result.grader = GRADER;
            return result;
        }
    }
    throw new Error('could not generate a puzzle');
}

// Rounds of constraint-reading allowed between placements (see logicalSolve).
const GAS_SWEEPS = 1;
// Bumped when grading changes, so puzzles queued under the old rules are dropped.
const GRADER = 4;

function solvable(def) {
    return logicalSolve(compile(def), def.givens, { sweeps: GAS_SWEEPS }).solved;
}

const MIN_CLUES_PER_RULE = 3;

// Removes givens, then redundant constraints, while the human-style solver
// can still finish. Keeps puzzles in "approachable" territory.
function minimise(def, r) {
    const isClassic = def.types.includes('classic');
    def.givens = def.solution.slice();
    for (const i of shuffle(r, [...Array(81).keys()])) {
        const g = def.givens[i];
        def.givens[i] = 0;
        if (!solvable(def)) def.givens[i] = g;
    }
    const refs = [];
    CON_KEYS.forEach(k => def[k].forEach(item => refs.push([k, item])));
    // In a combo, every rule keeps a few clues, so none of them disappears.
    const keep = CON_KEYS.filter(k => def[k].length).length > 1 ? MIN_CLUES_PER_RULE : 0;
    for (const [k, item] of shuffle(r, refs)) {
        if (def[k].length <= keep) continue;
        const idx = def[k].indexOf(item);
        def[k].splice(idx, 1);
        if (!solvable(def)) def[k].splice(idx, 0, item);
    }
    const res = logicalSolve(compile(def), def.givens, { sweeps: GAS_SWEEPS });
    const givenCount = def.givens.filter(Boolean).length;
    def.stats = Object.assign({ givens: givenCount }, res.counts);
    // How many digits needed a look at a constraint or a pointing pattern,
    // rather than plain singles.
    def.difficulty = res.counts.assisted;
    if (isClassic && givenCount > 30) return null;
    if (isClassic && res.counts.assisted < 1) return null;
    // GAS territory: the variant must matter, and every digit is one look away.
    if (!isClassic && (res.counts.assisted < 10 || givenCount > 18)) return null;
    // A combo whose builder produced nothing for one of its rules isn't a combo.
    if (def.types.length > 1 && CON_KEYS.filter(k => def[k].length).length < def.types.length) return null;
    return def;
}

// ------------------------------------------------------------------ escape rooms
//
// A case is three puzzles ("rooms") and a padlock. Room 1's 🔑 cells add up
// to the hidden total of a cage in room 2. Room 2's solve reveals a riddle
// describing room 3's unnamed rule. A symbol cell in each room gives a dial
// of the padlock. Built backwards (room 2's cage first, then room 1's keys
// to match), so every link is guaranteed to work.

const MYSTERY_RIDDLES = {
    whispers: 'Along each copper pipe, neighbouring digits are at least 5 apart.',
    renban: 'Each copper pipe carries a run of consecutive digits, in any order, with no repeats.',
    thermo: 'Heat rises from the valve: digits keep climbing along each copper pipe.',
};
const MYSTERY_TYPES = Object.keys(MYSTERY_RIDDLES);
const ROOM1_TYPES = ['thermo', 'xv', 'kropki', 'arrow', 'renban', 'whispers'];
const ROOM2_TYPES = [['killer'], ['killer', 'thermo'], ['killer', 'xv']];
const DIAL_SYMBOLS = ['★', '◆', '▲', '●'];

const CASE_STORY = {
    title: 'The Boiler Room',
    intro: 'You wake up on a cold concrete floor in the basement of an old Pretoria apartment block. The door has slammed shut behind you. ' +
        'The only way out is through three rooms, to an exit door with a four-dial padlock. Find the code.',
    rooms: [
        { name: 'The Cellar', icon: '🕯️', theme: 'cellar',
            intro: 'Dusty shelves and a single candle. Some cells are marked with a key 🔑. Solve the grid to read them.' },
        { name: 'The Furnace', icon: '🔥', theme: 'furnace',
            intro: 'One cage on the furnace door has no total, only a keyhole 🔑. Your keys might fit: tap 🔓 Use your keys when you know the number.' },
        { name: 'The Pipes', icon: '🔧', theme: 'pipes',
            intro: 'Copper pipes snake across the wall. Nobody left instructions for them… or did they? Check your notes 📜.' },
    ],
    exit: 'The exit door has a padlock with four dials: ★ ◆ ▲ ●. Each room you solved holds one symbol. The last one is a riddle.',
    escaped: 'The padlock clicks open and the door swings out into the sunshine. You escaped!',
};

// Cells of the solution that aren't givens, so they have to be solved.
const openCells = def => [...Array(81).keys()].filter(i => !def.givens[i]);

// k open cells in different boxes whose solution digits sum to target.
function findKeys(r, def, target) {
    const sizes = target <= 17 ? [2, 3] : target <= 24 ? [3, 4] : [4];
    const cells = openCells(def);
    for (const k of sizes) {
        for (let t = 0; t < 4000; t++) {
            const pickd = shuffle(r, cells.slice()).slice(0, k);
            if (new Set(pickd.map(boxOf)).size < k) continue;
            if (pickd.reduce((s, i) => s + def.solution[i], 0) === target) return pickd.sort((a, b) => a - b);
        }
    }
    return null;
}

function generateCase(opts) {
    opts = opts || {};
    const seed = opts.seed != null ? opts.seed : (Math.random() * 2 ** 32) >>> 0;
    const r = rng(seed);
    const sub = () => (r() * 2 ** 32) >>> 0;
    const story = CASE_STORY;
    for (let attempt = 0; attempt < 12; attempt++) {
        const mystery = pick(r, MYSTERY_TYPES);
        const room3 = generate({ types: [mystery], seed: sub() });
        const room2 = generate({ types: pick(r, ROOM2_TYPES.filter(t => !t.includes(mystery))), seed: sub() });
        // The locked cage: one the puzzle can't be solved without, if possible.
        const usable = room2.cages.map((c, k) => k).filter(k => room2.cages[k].sum >= 5 && room2.cages[k].sum <= 30);
        if (!usable.length) continue;
        const needed = usable.filter(k => {
            const without = Object.assign({}, room2, { cages: room2.cages.filter((_, j) => j !== k) });
            return !solvable(without);
        });
        const locked = pick(r, needed.length ? needed : usable);
        const total = room2.cages[locked].sum;
        const room1 = generate({ types: [pick(r, ROOM1_TYPES.filter(t => t !== mystery))], seed: sub() });
        const keys = findKeys(r, room1, total);
        if (!keys) continue;

        const rooms = [room1, room2, room3];
        const dialCells = rooms.map(def => pick(r, openCells(def).filter(i => !keys.includes(i) || def !== room1)));
        const riddleKind = pick(r, ['keys', 'total']);
        const last = riddleKind === 'keys' ? keys.length : total % 10;
        const code = dialCells.map((c, k) => rooms[k].solution[c]).concat(last);
        const caseInfo = {
            id: 'c' + seed.toString(36), seed, title: story.title, of: 3, intro: story.intro, exit: story.exit, escaped: story.escaped,
            dials: [
                { sym: '★', text: '★ is in ' + story.rooms[0].name + '.' },
                { sym: '◆', text: '◆ is in ' + story.rooms[1].name + '.' },
                { sym: '▲', text: '▲ is in ' + story.rooms[2].name + '.' },
                { sym: '●', text: riddleKind === 'keys' ? '● is how many keys you found in the cellar.' : '● is the last digit of the furnace\'s hidden total.' },
            ],
            code,
        };
        const notes = [
            'Behind a loose brick you find a note: “The furnace won\'t light without the sum of your keys.”',
            'As the furnace roars to life, words appear in the soot: “' + MYSTERY_RIDDLES[mystery] + '”',
            'A hatch swings open behind the pipes. The exit door is right there, with its padlock.',
        ];
        rooms.forEach((def, k) => {
            const room = story.rooms[k];
            def.typeTitle = def.title;
            def.title = room.name;
            def.room = { name: room.name, icon: room.icon, theme: room.theme, intro: room.intro, note: notes[k] };
            def.case = Object.assign({ n: k + 1 }, caseInfo);
            def.marks = [{ cell: dialCells[k], icon: DIAL_SYMBOLS[k], kind: 'dial' }];
        });
        room1.marks = keys.map(cell => ({ cell, icon: '🔑', kind: 'key' })).concat(room1.marks);
        room2.lockedCage = locked;
        room3.mystery = mystery;
        room3.rules = room3.rules.map(() => '🔒 Nobody wrote down the rule for the copper pipes. Check your notes 📜.');
        return { id: caseInfo.id, rooms };
    }
    throw new Error('could not build an escape room');
}

const api = {
    ALL, bit, POP, DIGITS, HOUSES, SEES, PEERS, rowOf, colOf, boxOf, cellName, houseName,
    RULES, TYPE_NAMES, THEMES, GRADER, MYSTERY_RIDDLES, compile, countSolutions, logicalSolve, hint, generate, generateCase, rng,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.SudokuEngine = api;
})(typeof self !== 'undefined' ? self : this);
