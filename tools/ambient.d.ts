// Ambient shims for dependencies that ship no TypeScript declarations of their own.
declare module "html-to-text" {
  export function convert(html: string, options?: Record<string, unknown>): string;
}
declare module "libmime" {
  function decodeWords(value: string): string;
  const libmime: { decodeWords: typeof decodeWords };
  export default libmime;
}
