declare module "crypto" {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string): {
      digest(encoding: "hex"): string;
    };
  };
}

declare module "fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function rename(from: string, to: string): Promise<void>;
  export function writeFile(
    path: string,
    data: string,
    options?: "utf8" | { flag?: string }
  ): Promise<void>;
}

declare module "path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function normalize(path: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}

declare module "url" {
  export function fileURLToPath(url: string | URL): string;
}
