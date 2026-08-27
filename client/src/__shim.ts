// Node shim: the engine's visibility-aware wait() reads document.hidden.
// Imported first so it runs before clientEngine code in the bundle.
if (!(globalThis as any).document) {
  (globalThis as any).document = { hidden: false };
}
export {};
