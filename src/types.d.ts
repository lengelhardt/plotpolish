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

// src/live-cases.test.ts writes the harness's case file (see that file's header).
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
}
declare module "node:path" {
  export function resolve(...parts: string[]): string;
}

// vite.config.ts resolves LICENSE relative to itself.
declare module "url" {
  export function fileURLToPath(url: string | URL): string;
}
declare const process: { cwd(): string; env: Record<string, string | undefined> };
