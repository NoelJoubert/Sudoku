// Generates puzzles off the main thread so the page never freezes.
importScripts('engine.js');

self.onmessage = e => {
    const { id, types, kind } = e.data;
    try {
        const def = kind === 'case' ? SudokuEngine.generateCase({}) : SudokuEngine.generate({ types });
        self.postMessage({ id, def });
    } catch (err) {
        self.postMessage({ id, error: String(err) });
    }
};
