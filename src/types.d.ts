declare module "*.py?raw" {
  const src: string;
  export default src;
}

// The project has no @types/node dependency (nothing in src/ touches Node
// APIs otherwise) — this covers only what src/iife.test.ts needs to read a
// build artifact off disk.
declare module "fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
}
