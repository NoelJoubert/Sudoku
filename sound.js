// Piano sounds, synthesised with Web Audio (no sound files).
//
// Every puzzle gets a classical piece. Each digit you place plays the next
// note of its melody, with the left hand underneath, so you perform the
// piece as you solve; finished rows, cages and lines play chords in its key;
// solving plays the piece. Or, in 'scale' style, each digit plays its own
// note of the piece's scale.
(function (root) {
'use strict';

// ------------------------------------------------------------------ the pieces
//
// A part is a list of "note:beats" tokens. R is a rest, "C3+E3+G3" is a
// chord, beats may be fractions ("1/3" for triplets), and a trailing ! plays
// the note loudly. `melody` is the right hand; `left`, when given, runs
// alongside it with its own rhythm, and `double` adds the melody shifted by
// that many semitones (octave unisons). Bars are written as separate strings
// only for readability.

const times = (s, n) => Array(n).fill(s).join(' ');
// Repeated chords on every `step` beats.
const pulse = (chord, beats, step) => times(chord + ':' + (step || 0.5), Math.round(beats / (step || 0.5)));
// Alberti bass: low, high, middle, high in eighths, for 2 beats.
const alberti = (lo, mid, hi, n) => times(`${lo}:.5 ${hi}:.5 ${mid}:.5 ${hi}:.5`, n || 1);
// A waltz bar: the bass, then the chord twice.
const waltz = (bass, chord, n) => times(`${bass}:1 ${chord}:1 ${chord}:1`, n || 1);
const bars = (...b) => b.join(' ');

const PIECES = [
    // ---- the originals (their ids stay, so saved puzzles keep their piece)
    { id: 'ode', title: 'Ode to Joy', by: 'Beethoven', bpm: 132, key: 'D4', chord: ['D3', 'F#3', 'A3', 'D4', 'F#4'],
        melody: bars('F#4:1 F#4:1 G4:1 A4:1', 'A4:1 G4:1 F#4:1 E4:1', 'D4:1 D4:1 E4:1 F#4:1', 'F#4:1.5 E4:.5 E4:2',
            'F#4:1 F#4:1 G4:1 A4:1', 'A4:1 G4:1 F#4:1 E4:1', 'D4:1 D4:1 E4:1 F#4:1', 'E4:1.5 D4:.5 D4:2'),
        left: bars('D3:1 F#3+A3:1 D3:1 F#3+A3:1', 'D3:1 F#3+A3:1 A2:1 E3+G3:1', 'D3:1 F#3+A3:1 D3:1 F#3+A3:1', 'A2:1 E3+G3:1 A2:1 E3+G3:1',
            'D3:1 F#3+A3:1 D3:1 F#3+A3:1', 'D3:1 F#3+A3:1 A2:1 E3+G3:1', 'D3:1 F#3+A3:1 A2:1 E3+G3:1', 'D3+A3:4') },
    { id: 'elise', title: 'Für Elise', by: 'Beethoven', bpm: 150, key: 'A3', minor: true, chord: ['A2', 'E3', 'A3', 'C4', 'E4'],
        melody: bars('E5:.5 D#5:.5', 'E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5', 'A4:1.5 C4:.5 E4:.5 A4:.5', 'B4:1.5 E4:.5 G#4:.5 B4:.5',
            'C5:1.5 E4:.5 E5:.5 D#5:.5', 'E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5', 'A4:1.5 C4:.5 E4:.5 A4:.5', 'B4:1.5 E4:.5 C5:.5 B4:.5', 'A4:3'),
        left: bars('R:4', 'A2:.5 E3:.5 A3:.5 R:1.5', 'E2:.5 E3:.5 G#3:.5 R:1.5', 'A2:.5 E3:.5 A3:.5 R:1.5',
            'R:3', 'A2:.5 E3:.5 A3:.5 R:1.5', 'E2:.5 E3:.5 G#3:.5 R:1.5', 'A2:.5 E3:.5 A3:2') },
    { id: 'nacht', title: 'Eine kleine Nachtmusik', by: 'Mozart', bpm: 132, key: 'G3', chord: ['G2', 'D3', 'G3', 'B3', 'D4'],
        melody: bars('G4:1 R:.5 D4:.5 G4:1 R:.5 D4:.5', 'G4:.5 D4:.5 G4:.5 B4:.5 D5:2', 'C5:1 R:.5 A4:.5 C5:1 R:.5 A4:.5', 'C5:.5 A4:.5 F#4:.5 A4:.5 D4:2'),
        double: -12 },
    { id: 'prelude', title: 'Prelude in C', by: 'J. S. Bach', bpm: 76, key: 'C4', chord: ['C3', 'G3', 'C4', 'E4', 'G4'],
        melody: [
            'C4 E4 G4 C5 E5 G4 C5 E5', 'C4 E4 G4 C5 E5 G4 C5 E5',
            'C4 D4 A4 D5 F5 A4 D5 F5', 'C4 D4 A4 D5 F5 A4 D5 F5',
            'B3 D4 G4 D5 F5 G4 D5 F5', 'B3 D4 G4 D5 F5 G4 D5 F5',
            'C4 E4 G4 C5 E5 G4 C5 E5', 'C4 E4 G4 C5 E5 G4 C5 E5',
        ].join(' ').split(' ').map(n => n + ':.25').join(' '),
        left: 'C3:2 C3:2 C3:2 C3:2 B2:2 B2:2 C3:2 C3:2' },
    { id: 'canon', title: 'Canon in D', by: 'Pachelbel', bpm: 80, key: 'D4', chord: ['D3', 'A3', 'D4', 'F#4', 'A4'],
        melody: bars('F#5:2 E5:2 D5:2 C#5:2 B4:2 A4:2 B4:2 C#5:2',
            'D5:1 C#5:1 B4:1 A4:1 G4:1 F#4:1 G4:1 E4:1', 'D4:1 F#4:1 A4:1 G4:1 F#4:1 D4:1 F#4:1 E4:1', 'D4:4'),
        left: bars(times('D3+A3:2 A2+E3:2 B2+F#3:2 F#2+C#3:2 G2+D3:2 D2+A2:2 G2+D3:2 A2+E3:2', 2), 'D2+A2+D3:4') },
    { id: 'lullaby', title: 'Lullaby', by: 'Brahms', bpm: 104, key: 'C4', chord: ['C3', 'G3', 'C4', 'E4', 'G4'],
        melody: bars('E4:.5 E4:.5', 'G4:2 E4:.5 E4:.5', 'G4:2 E4:.5 G4:.5', 'C5:1 B4:1.5 A4:.5', 'A4:1 G4:1 D4:.5 E4:.5',
            'F4:1 D4:1 D4:.5 E4:.5', 'F4:2 D4:.5 F4:.5', 'B4:.5 A4:.5 G4:1 B4:1', 'C5:3'),
        left: bars('R:1', waltz('C3', 'E3+G3', 2), waltz('F2', 'F3+A3'), waltz('C3', 'E3+G3'), waltz('G2', 'F3+B3', 3), 'C3+G3+E4:3') },
    { id: 'twinkle', title: 'Ah vous dirai-je, maman', by: 'Mozart', bpm: 112, key: 'C4', chord: ['C3', 'G3', 'C4', 'E4', 'G4'],
        melody: bars('C4:1 C4:1 G4:1 G4:1', 'A4:1 A4:1 G4:2', 'F4:1 F4:1 E4:1 E4:1', 'D4:1 D4:1 C4:2'),
        left: bars('C3:1 C4:1 E3:1 C4:1', 'F3:1 C4:1 E3:1 C4:1', 'D3:1 B3:1 C3:1 A3:1', 'F3:1 G3:1 C3:2') },

    // ---- more piano and orchestral favourites
    { id: 'moonlight', title: 'Moonlight Sonata', by: 'Beethoven', bpm: 54, key: 'C#3', minor: true, chord: ['C#2', 'G#2', 'C#3', 'E3', 'G#3'],
        melody: bars(times('G#3:1/3 C#4:1/3 E4:1/3', 4), times('G#3:1/3 C#4:1/3 E4:1/3', 4),
            times('A3:1/3 C#4:1/3 E4:1/3', 2), times('A3:1/3 D4:1/3 F#4:1/3', 2),
            'G#3:1/3 B#3:1/3 F#4:1/3 G#3:1/3 C#4:1/3 E4:1/3 G#3:1/3 C#4:1/3 D#4:1/3 F#3:1/3 B#3:1/3 D#4:1/3',
            times('G#3:1/3 C#4:1/3 E4:1/3', 3), 'C#4+E4+G#4:1'),
        left: 'C#2+C#3:4 B1+B2:4 A1+A2:2 F#1+F#2:2 G#1+G#2:4 C#2+C#3:4' },
    { id: 'fifth', title: 'Symphony No. 5', by: 'Beethoven', bpm: 108, key: 'C3', minor: true, chord: ['C2', 'G2', 'C3', 'Eb3', 'G3'],
        melody: bars('R:.5 G4:.5! G4:.5! G4:.5!', 'Eb4:3!', 'R:.5 F4:.5! F4:.5! F4:.5!', 'D4:3!',
            'R:.5 G4:.5 G4:.5 G4:.5', 'Eb4:.5 Ab4:.5 Ab4:.5 Ab4:.5', 'G4:.5 Eb5:.5 Eb5:.5 Eb5:.5', 'C5:2'),
        double: -12 },
    { id: 'turca', title: 'Rondo alla Turca', by: 'Mozart', bpm: 120, key: 'A3', minor: true, chord: ['A2', 'E3', 'A3', 'C4', 'E4'],
        melody: bars('B4:.25 A4:.25 G#4:.25 A4:.25', 'C5:.5 R:.5 D5:.25 C5:.25 B4:.25 C5:.25', 'E5:.5 R:.5 F5:.25 E5:.25 D#5:.25 E5:.25',
            'B5:.25 A5:.25 G#5:.25 A5:.25 B5:.25 A5:.25 G#5:.25 A5:.25', 'C6:1 A5:.5 C6:.5',
            'B5:.5 A5:.5 G5:.5 A5:.5', 'B5:.5 A5:.5 G5:.5 A5:.5', 'B5:.5 A5:.5 G5:.5 F#5:.5', 'E5:2'),
        left: bars('R:1', pulse('A2', 1), pulse('C3+E3', 1), pulse('A2', 1), pulse('C3+E3', 1), pulse('E2', 1), pulse('B2+E3', 1), pulse('A2', 1), pulse('C3+E3', 1),
            pulse('E2', 1), pulse('G3+B3', 1), pulse('E2', 1), pulse('G3+B3', 1), pulse('B1', 1), pulse('D#3+A3', 1), 'E2+B2+E3:2') },
    { id: 'k545', title: 'Sonata in C, K. 545', by: 'Mozart', bpm: 120, key: 'C4', chord: ['C3', 'G3', 'C4', 'E4', 'G4'],
        melody: bars('C5:2 E5:1 G5:1', 'B4:1.5 C5:.25 D5:.25 C5:2', 'A5:2 G5:1 C6:1', 'G5:1 F5:.5 G5:.25 F5:.25 E5:2'),
        left: bars(alberti('C3', 'E3', 'G3', 2), alberti('D3', 'F3', 'G3'), alberti('C3', 'E3', 'G3'),
            alberti('C3', 'F3', 'A3'), alberti('C3', 'E3', 'G3'), alberti('B2', 'D3', 'G3'), 'C3+G3+C4:2') },
    { id: 'mozart40', title: 'Symphony No. 40', by: 'Mozart', bpm: 200, key: 'G3', minor: true, chord: ['G2', 'D3', 'G3', 'Bb3', 'D4'],
        melody: bars('Eb5:.5 D5:.5', 'D5:1 Eb5:.5 D5:.5', 'D5:1 Eb5:.5 D5:.5', 'D5:1 Bb5:1', 'Bb5:.5 A5:.5 G5:1',
            'G5:.5 F5:.5 Eb5:1', 'Eb5:.5 D5:.5 C5:1', 'C5:2'),
        left: bars(pulse('G3+Bb3', 7), pulse('A3+C4', 2), pulse('Bb3+D4', 2), pulse('F#3+C4', 2), 'G3+Bb3:2') },
    { id: 'minuet', title: 'Minuet in G', by: 'Petzold (Bach notebook)', bpm: 120, key: 'G3', chord: ['G2', 'D3', 'G3', 'B3', 'D4'],
        melody: bars('D5:1 G4:.5 A4:.5 B4:.5 C5:.5', 'D5:1 G4:1 G4:1', 'E5:1 C5:.5 D5:.5 E5:.5 F#5:.5', 'G5:1 G4:1 G4:1',
            'C5:1 D5:.5 C5:.5 B4:.5 A4:.5', 'B4:1 C5:.5 B4:.5 A4:.5 G4:.5', 'F#4:1 G4:.5 A4:.5 B4:.5 G4:.5', 'A4:3'),
        left: 'G3+B3:2 A3:1 B3:3 C4:3 B3:3 A3:3 G3:3 D4:1 B3:1 G3:1 D4:2 D3:1' },
    { id: 'jesu', title: 'Jesu, Joy of Man\'s Desiring', by: 'J. S. Bach', bpm: 60, key: 'G3', chord: ['G2', 'D3', 'G3', 'B3', 'D4'],
        melody: bars('G4:1/3 A4:1/3 B4:1/3', 'D5:1/3 C5:1/3 C5:1/3', 'E5:1/3 D5:1/3 D5:1/3', 'G5:1/3 F#5:1/3 G5:1/3', 'D5:1/3 B4:1/3 G4:1/3', 'G4:2'),
        left: 'G2+D3:1 C3+G3:1 G2+D3:1 B2+D3:1 G2+D3:1 G2+B2+D3:2' },
    { id: 'mountain', title: 'In the Hall of the Mountain King', by: 'Grieg', bpm: 126, key: 'B2', minor: true, chord: ['B1', 'F#2', 'B2', 'D3', 'F#3'],
        melody: bars('B3:.5 C#4:.5 D4:.5 E4:.5 F#4:.5 D4:.5 F#4:1', 'F4:.5 C#4:.5 F4:1 E4:.5 C4:.5 E4:1',
            'B3:.5 C#4:.5 D4:.5 E4:.5 F#4:.5 D4:.5 F#4:.5 B4:.5', 'A4:.5 F#4:.5 D4:.5 F#4:.5 A4:2'),
        left: bars(times('B2:1 F#2:1', 2), times('C#3:1 F#2:1', 2), times('B2:1 F#2:1', 2), 'D3:1 F#2:1 B2+F#3:2') },
    { id: 'morning', title: 'Morning Mood', by: 'Grieg', bpm: 100, key: 'E3', chord: ['E2', 'B2', 'E3', 'G#3', 'B3'],
        melody: bars('G#5:.75 E5:.25 C#5:.5 B4:.5 C#5:.5 E5:.5', 'G#5:.75 E5:.25 C#5:.5 B4:.5 C#5:.5 E5:.5',
            'G#5:.75 E5:.25 G#5:.5 B5:.5 G#5:.5 B5:.5', 'C#6:1.5 B5:1.5', 'E5:3'),
        left: 'E2+B2+G#3:3 E2+B2+G#3:3 E2+B2+G#3:3 A2+E3+C#4:3 E2+B2+G#3:3' },
    { id: 'swan', title: 'Swan Lake', by: 'Tchaikovsky', bpm: 76, key: 'B2', minor: true, chord: ['B1', 'F#2', 'B2', 'D3', 'F#3'],
        melody: bars('F#5:3 B4:.25 C#5:.25 D5:.25 E5:.25', 'F#5:1.5 D5:.5 F#5:1.5 D5:.5', 'F#5:1.5 B4:.5 D5:.5 B4:.5 G4:.5 D5:.5', 'B4:4'),
        left: bars(pulse('B2+D3+F#3', 4, 1/3), pulse('B2+D3+F#3', 2, 1/3), pulse('D3+F#3+A3', 2, 1/3), pulse('G2+B2+D3', 2, 1/3), pulse('G2+B2+E3', 2, 1/3), 'B1+F#2+B2+D3:4') },
    { id: 'newworld', title: 'Largo, New World Symphony', by: 'Dvořák', bpm: 54, key: 'Db3', chord: ['Db2', 'Ab2', 'Db3', 'F3', 'Ab3'],
        melody: bars('F4:1.5 Ab4:.5 Ab4:2', 'F4:1.5 Eb4:.5 Db4:2', 'Eb4:1 F4:1 Ab4:1 F4:1', 'Eb4:4',
            'F4:1.5 Ab4:.5 Ab4:2', 'F4:1.5 Eb4:.5 Db4:2', 'Eb4:1 F4:1 Eb4:1 Db4:1', 'Db4:4'),
        left: 'Db3+Ab3:4 Gb2+Db3:2 Db3+Ab3:2 Db3+Ab3:2 Ab2+Eb3:2 Ab2+Eb3+Gb3:4 Db3+Ab3:4 Gb2+Db3:2 Db3+Ab3:2 Ab2+Eb3+Gb3:4 Db2+Ab2+Db3:4' },
    { id: 'gymnopedie', title: 'Gymnopédie No. 1', by: 'Satie', bpm: 76, key: 'D3', chord: ['D2', 'A2', 'D3', 'F#3', 'A3'],
        melody: bars('R:1 F#5:1 A5:1', 'G5:1 F#5:1 C#5:1', 'B4:1 C#5:1 D5:1', 'A4:3', 'F#4:3', 'F#4:3'),
        left: times('G2:1 B3+D4+F#4:2 D2:1 A3+C#4+F#4:2', 3) },
    { id: 'spring', title: 'Spring, The Four Seasons', by: 'Vivaldi', bpm: 100, key: 'E3', chord: ['E2', 'B2', 'E3', 'G#3', 'B3'],
        melody: bars('E5:1', 'G#5:.5 G#5:.5 G#5:.5 F#5:.25 E5:.25 B5:1.5 B5:.25 A5:.25', 'G#5:.5 G#5:.5 G#5:.5 F#5:.25 E5:.25 B5:1.5 B5:.25 A5:.25',
            'G#5:.5 A5:.5 B5:.5 A5:.5 G#5:1 F#5:1', 'E5:2'),
        left: bars('R:1', pulse('E3+G#3', 4), pulse('E3+G#3', 4), pulse('E3+G#3', 2), pulse('D#3+F#3+B3', 2), 'E2+B2+E3:2') },
    { id: 'danube', title: 'The Blue Danube', by: 'Johann Strauss II', bpm: 168, key: 'D3', chord: ['D2', 'A2', 'D3', 'F#3', 'A3'],
        melody: bars('D4:1', 'D4:1 F#4:1 A4:1', 'A4:3', 'R:1 A5:1 A5:1', 'R:1 F#5:1 F#5:1', 'R:2 D4:1',
            'D4:1 F#4:1 A4:1', 'A4:3', 'R:1 A5:1 A5:1', 'R:1 G5:1 G5:1', 'R:2 C#4:1',
            'C#4:1 E4:1 B4:1', 'B4:3', 'R:1 B5:1 B5:1', 'R:1 G5:1 G5:1', 'R:2 C#4:1',
            'C#4:1 E4:1 B4:1', 'B4:3', 'R:1 B5:1 B5:1', 'R:1 F#5:1 F#5:1', 'R:2 D4:1', 'D4:1 F#4:1 A4:1', 'D5:3'),
        left: bars('R:1', waltz('D2', 'F#3+A3', 8), waltz('A1', 'G3+C#4', 10), waltz('D2', 'F#3+A3', 3), 'D2+A2+F#3:3') },
    { id: 'habanera', title: 'Habanera, Carmen', by: 'Bizet', bpm: 92, key: 'D3', minor: true, chord: ['D2', 'A2', 'D3', 'F3', 'A3'],
        melody: bars('D5:.75 C#5:.25 C5:.5 C5:.5', 'B4:.75 Bb4:.25 A4:1', 'Ab4:.75 G4:.25 F4:.75 E4:.25', 'F4:.5 G4:.5 F4:.5 E4:.5', 'D4:2'),
        left: bars(times('D2:.75 D3:.25 A2:.5 D3:.5', 2), 'D2:.75 D3:.25 A2:.5 D3:.5', 'A1:.75 A2:.25 E2:.5 A2:.5', 'D2+A2+D3:2') },
    { id: 'bridal', title: 'Bridal Chorus', by: 'Wagner', bpm: 72, key: 'F3', chord: ['F2', 'C3', 'F3', 'A3', 'C4'],
        melody: bars('C4:1', 'F4:.75 F4:.25 F4:2 C4:1', 'G4:.75 E4:.25 F4:2 C4:1', 'F4:1 Bb4:.75 Bb4:.25 A4:1 G4:1', 'F4:.75 E4:.25 F4:1 G4:2', 'C4:1 F4:3'),
        left: 'R:1 F2+C3+A3:3 F2+C3+A3:1 C3+E3+Bb3:3 F2+C3+A3:1 Bb2+D3+F3:2 C3+F3+A3:2 C3+E3+G3:4 F2+C3+F3+A3:4' },
    { id: 'surprise', title: 'Surprise Symphony', by: 'Haydn', bpm: 104, key: 'C3', chord: ['C2', 'G2', 'C3', 'E3', 'G3'],
        melody: bars('C4:.5 C4:.5 E4:.5 E4:.5', 'G4:.5 G4:.5 E4:1', 'F4:.5 F4:.5 D4:.5 D4:.5', 'B3:.5 B3:.5 G3:1',
            'C4:.5 C4:.5 E4:.5 E4:.5', 'G4:.5 G4:.5 C5+E5+G5:1!', 'G4:.5 F4:.5 E4:.5 D4:.5', 'C4:2'),
        left: 'C3:1 E3+G3:1 C3:1 E3+G3:1 G2:1 F3+B3:1 G2:1 D3+F3:1 C3:1 E3+G3:1 C3:1 C2+C3+E3+G3:1! G2:1 F3+B3:1 C3+G3:2' },
    { id: 'greensleeves', title: 'Greensleeves', by: 'Traditional English', bpm: 110, key: 'A3', minor: true, chord: ['A2', 'E3', 'A3', 'C4', 'E4'],
        melody: bars('A4:1', 'C5:2 D5:1', 'E5:1.5 F5:.5 E5:1', 'D5:2 B4:1', 'G4:1.5 A4:.5 B4:1', 'C5:2 A4:1', 'A4:1.5 G#4:.5 A4:1',
            'B4:2 G#4:1', 'E4:2 A4:1', 'C5:2 D5:1', 'E5:1.5 F5:.5 E5:1', 'D5:2 B4:1', 'G4:1.5 A4:.5 B4:1',
            'C5:1.5 B4:.5 A4:1', 'G#4:1.5 F#4:.5 G#4:1', 'A4:3'),
        left: bars('R:1', waltz('A2', 'C3+E3'), waltz('C3', 'E3+G3'), waltz('G2', 'D3+G3'), waltz('E2', 'B2+E3'), waltz('A2', 'C3+E3'),
            waltz('F2', 'C3+F3'), waltz('E2', 'B2+G#3', 2), waltz('A2', 'C3+E3'), waltz('C3', 'E3+G3'), waltz('G2', 'D3+G3'),
            waltz('E2', 'B2+E3'), waltz('A2', 'C3+E3'), waltz('E2', 'B2+G#3'), 'A2+E3+A3:3') },

    // ---- originals for this app, in the spirit of Eric Whitacre's choral
    // writing: slow, with shimmering added-note chords. (His own pieces are
    // under copyright, so they aren't transcribed here.)
    { id: 'karoo', title: 'Stars over the Karoo', by: 'original, in the spirit of Eric Whitacre', bpm: 54, key: 'C3', chord: ['C2', 'G2', 'D3', 'E3', 'G3', 'D4'],
        melody: bars('E5:1.5 D5:.5 E5:2', 'G5:2 E5:1 D5:1', 'C5:1.5 D5:.5 E5:2', 'D5:4', 'B4:1 C5:1 D5:1 G5:1', 'E5:2 D5:1 C5:1', 'D5:2 C5:1 B4:1', 'C5:4'),
        left: 'C3+G3+D4+E4:4 A2+E3+B3+C4:4 F2+C3+E3+A3+G4:4 G2+D3+A3+C4:2 G2+D3+A3+B3:2 E2+B2+G3+D4:4 F2+C3+A3+E4:4 G2+D3+F3+A3:4 C2+G2+E3+D4+G4:4' },
    { id: 'stillwater', title: 'Still Water', by: 'original, in the spirit of Eric Whitacre', bpm: 50, key: 'A2', minor: true, chord: ['A1', 'E2', 'B2', 'C3', 'E3', 'B3'],
        melody: bars('C5:2 B4:1 C5:1', 'E5:3 D5:1', 'E5:1 G5:1 E5:1 D5:1', 'D5:3 B4:1', 'A4:1 C5:1 D5:1 E5:1', 'F5:2 E5:2', 'C5:2 B4:2', 'A4:4'),
        left: 'A2+E3+B3+C4:4 F2+C3+G3+A3:4 C3+G3+D4+E4:4 G2+D3+A3+B3:4 D3+A3+E4+F4:4 F2+C3+G3+A3+E4:4 E2+B2+A3+D4:2 E2+B2+G#3+D4:2 A1+E2+B3+C4+E4:4' },
    { id: 'lantern', title: 'Lantern Song', by: 'original, in the spirit of Eric Whitacre', bpm: 56, key: 'G2', chord: ['G1', 'D2', 'A2', 'B2', 'D3', 'A3'],
        melody: bars('B4:1 D5:1 E5:2', 'D5:1 B4:1 A4:2', 'G4:1 A4:1 B4:1 D5:1', 'E5:3 D5:1', 'E5:1 F#5:1 G5:2', 'F#5:1 E5:1 D5:2', 'C5:2 B4:1 A4:1', 'B4:4'),
        left: 'G2+D3+A3+B3:4 E2+B2+F#3+G3:4 C3+G3+D4+E4:4 D3+A3+E4+G4:4 C3+G3+B3+E4:4 A2+E3+G3+B3+D4:4 D2+A2+C4+E4:4 G2+D3+A3+B3+D4:4' },
];

const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = name => {
    const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
    if (!m) throw new Error('bad note ' + name);
    return 12 * (+m[3] + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
};
const beatsOf = b => (b.includes('/') ? b.split('/').reduce((x, y) => x / y) : parseFloat(b));
// Events { ms: [midi…] (empty for a rest), beats, t (start, in beats), loud }.
const parse = text => {
    let t = 0;
    return text.trim().split(/\s+/).map(tok => {
        const loud = tok.endsWith('!');
        const [n, b] = tok.replace(/!$/, '').split(':');
        const ev = { ms: n === 'R' ? [] : n.split('+').map(midi), beats: beatsOf(b), t, loud };
        t += ev.beats;
        return ev;
    });
};
PIECES.forEach(p => {
    p.notes = parse(p.melody);
    p.left = p.left ? parse(p.left) : [];
    if (p.double) p.left = p.left.concat(p.notes.map(e => Object.assign({}, e, { ms: e.ms.map(m => m + p.double), double: true })));
    p.left.sort((a, b) => a.t - b.t);
    p.length = p.notes.reduce((s, e) => s + e.beats, 0);
    p.playable = p.notes.map((n, k) => k).filter(k => p.notes[k].ms.length);
});

const MAJOR = [0, 2, 4, 5, 7, 9, 11, 12, 14];
const MINOR = [0, 2, 3, 5, 7, 8, 10, 12, 14];

// ------------------------------------------------------------------ the piano

let ctx = null, out = null, wet = null, noise = null;
let enabled = true;

// A concert-hall reverb: decorrelated noise in each ear, fading
// exponentially and getting darker as it fades, after a short pre-delay.
function hall(seconds) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds), pre = Math.floor(rate * 0.018);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let lp = 0;
        for (let i = pre; i < len; i++) {
            const x = (i - pre) / (len - pre);
            const k = 0.12 + 0.8 * x; // more smoothing (darker) later in the tail
            lp += (Math.random() * 2 - 1 - lp) * (1 - k);
            d[i] = lp * Math.exp(-6.5 * x) * (1 + 0.5 * k);
        }
    }
    return buf;
}

function ensure() {
    if (!enabled) return null;
    if (!ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return null;
        setup(new AC());
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
}

function setup(c) {
    ctx = c;
    out = ctx.createGain();
    out.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    out.connect(comp);
    comp.connect(ctx.destination);
    const verb = ctx.createConvolver();
    verb.buffer = hall(2.6);
    wet = ctx.createGain();
    wet.gain.value = 0.3;
    wet.connect(verb);
    verb.connect(comp);
    // A short burst of noise for the hammer hitting the strings.
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

// One piano note. A struck string is a set of slightly stretched partials
// (inharmonicity), the higher ones dying away faster; doubled strings
// slightly out of tune with each other give the slow beating of a real
// piano; a quick fall after the strike, then a long soft aftersound; a felt
// hammer thump; brightness that grows with how hard the key is struck and
// mellows as the note rings; and dampers that stop it when it's released.
function tone(m, at, len, vel, bus) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const v = Math.min(1, vel / 0.25);
    const ring = Math.max(0.9, Math.min(10, 8 * Math.pow(261.6 / f, 0.75)));
    const off = at + Math.max(0.08, Math.min(len, ring * 1.5));
    const dest = ctx.createGain();
    dest.connect(bus ? bus.dry : out);
    dest.connect(bus ? bus.wet : wet);
    let tail = dest;
    if (ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = Math.max(-0.6, Math.min(0.6, (m - 62) / 34));
        pan.connect(dest);
        tail = pan;
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(Math.min(16000, f * (3 + 14 * v) + 900), at);
    lp.frequency.setTargetAtTime(Math.min(7000, f * 2.2 + 500), at + 0.01, 0.3 + ring * 0.04);
    lp.connect(tail);

    // The note's loudness: strike, quick fall, aftersound, then the damper.
    const env = ctx.createGain();
    const after = Math.min(at + 0.35, off - 0.01);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(vel, at + 0.004);
    env.gain.setTargetAtTime(vel * 0.42, at + 0.006, 0.07 + ring * 0.015);
    env.gain.setTargetAtTime(0, after, ring / 4.5);
    env.gain.setTargetAtTime(0, off, 0.09);
    env.connect(lp);

    const B = Math.min(0.0025, 0.00018 * Math.pow(f / 261.6, 1.1));
    const parts = [];
    for (let n = 1; n <= 10; n++) {
        const fn = n * f * Math.sqrt(1 + B * n * n);
        if (fn > 12000) break;
        // Struck about an eighth of the way along, so the 8th partial is weak.
        const a = Math.abs(Math.sin(Math.PI * n / 8.3)) / Math.pow(n, 1.1 + 0.6 * (1 - v));
        parts.push([fn, a, n]);
    }
    const total = parts.reduce((s, p) => s + p[1], 0);
    const stop = off + 0.6;
    parts.forEach(([fn, a, n]) => {
        const g = ctx.createGain();
        const decay = ring / (1 + 0.7 * (n - 1));
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(a / total, at + 0.003);
        g.gain.setTargetAtTime(0, at + 0.003, decay / 3.5);
        g.connect(env);
        const strings = n <= 3 ? [-1, 1] : [0];
        strings.forEach(s => {
            const o = ctx.createOscillator();
            o.frequency.value = fn;
            o.detune.value = s * (0.9 + 0.5 * Math.random()) + (Math.random() - 0.5) * 0.4;
            const og = ctx.createGain();
            og.gain.value = 1 / strings.length;
            o.connect(og);
            og.connect(g);
            o.start(at);
            o.stop(stop);
        });
    });

    // The hammer.
    const h = ctx.createBufferSource();
    h.buffer = noise;
    const hb = ctx.createBiquadFilter();
    hb.type = 'bandpass';
    hb.frequency.value = Math.min(5000, f * 2.5 + 300);
    hb.Q.value = 0.9;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(vel * (0.08 + 0.25 * v), at);
    hg.gain.setTargetAtTime(0, at + 0.002, 0.012);
    h.connect(hb);
    hb.connect(hg);
    hg.connect(tail);
    h.start(at);
    h.stop(at + 0.08);
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

const MEL_VEL = 0.21, LEFT_VEL = 0.12;
const velOf = (e, base) => (e.loud ? Math.min(0.32, base * 1.6) : base) * (e.ms.length > 2 ? 0.8 : 1);

// A digit was placed. n counts the digits placed so far on this puzzle, so
// placing them in turn walks through the melody, and taking one back and
// re-placing it replays the same note. The left hand plays what falls under
// that melody note.
function place(piece, n, digit, style) {
    if (!ensure()) return;
    if (style === 'scale') {
        const scale = piece.minor ? MINOR : MAJOR;
        return tone(midi(piece.key) + 12 + scale[digit - 1], now(), 1.6, 0.2);
    }
    const P = piece.playable;
    const k = P[((n % P.length) + P.length) % P.length];
    const ev = piece.notes[k], next = piece.notes[k + 1] ? piece.notes[k + 1].t : piece.length;
    const beat = 60 / piece.bpm, at = now();
    ev.ms.forEach(m => tone(m, at, Math.max(1.4, ev.beats * beat * 2), velOf(ev, MEL_VEL)));
    piece.left.filter(e => e.t >= ev.t && e.t < next).forEach(e =>
        e.ms.forEach(m => tone(m, at + (e.t - ev.t) * beat, Math.max(1.2, e.beats * beat * 1.5), velOf(e, LEFT_VEL))));
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
// it can be faded out and stopped midway. Notes are scheduled a little
// ahead as it plays, rather than all at once.
let playing = null;
const AHEAD = 1.5;

function stop() {
    if (!playing) return;
    const p = playing;
    playing = null;
    clearTimeout(p.timer);
    clearTimeout(p.endTimer);
    const t = ctx.currentTime;
    [p.bus.dry, p.bus.wet].forEach(g => {
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.15);
    });
    setTimeout(() => { p.bus.dry.disconnect(); p.bus.wet.disconnect(); }, 400);
    if (p.onEnd) p.onEnd();
}

// Every note of a piece as { at (seconds from the start), m, len, vel }.
function score(piece) {
    const beat = 60 / piece.bpm, out = [];
    piece.notes.forEach(e => e.ms.forEach(m => out.push({ at: e.t * beat, m, len: Math.max(0.5, e.beats * beat * 1.7 + 0.15), vel: velOf(e, MEL_VEL) })));
    piece.left.forEach(e => e.ms.forEach(m => out.push({ at: e.t * beat, m, len: Math.max(0.6, e.beats * beat * 1.3 + 0.25), vel: velOf(e, LEFT_VEL) })));
    const end = piece.length * beat + 0.15;
    keyChord(piece).forEach((m, k) => out.push({ at: end + k * 0.06, m, len: 3.5, vel: 0.11 }));
    return out.sort((a, b) => a.at - b.at);
}

// The puzzle is solved: the piece, then its home chord. Replaces any tune
// already playing. onEnd runs when it finishes or is stopped.
function finale(piece, delay, onEnd) {
    if (!ensure()) return 0;
    stop();
    const bus = { dry: ctx.createGain(), wet: ctx.createGain() };
    bus.dry.connect(out);
    bus.wet.connect(wet);
    const notes = score(piece), start = now() + (delay || 0);
    const me = { bus, onEnd };
    let i = 0;
    (function feed() {
        if (playing !== me && i) return;
        const until = ctx.currentTime + AHEAD;
        while (i < notes.length && start + notes[i].at < until) {
            const n = notes[i++];
            tone(n.m, Math.max(start + n.at, ctx.currentTime), n.len, n.vel, bus);
        }
        if (i < notes.length) me.timer = setTimeout(feed, 250);
    })();
    const secs = start + notes[notes.length - 1].at + 3.5 - ctx.currentTime;
    me.endTimer = setTimeout(() => {
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

// For tests: render into an OfflineAudioContext.
function _useContext(c) { setup(c); }

root.SudokuSound = { PIECES, pieceFor, place, complete, finale, stop, isPlaying, setEnabled, unlock, score, tone: (...a) => tone(...a), _useContext };
})(typeof self !== 'undefined' ? self : this);
