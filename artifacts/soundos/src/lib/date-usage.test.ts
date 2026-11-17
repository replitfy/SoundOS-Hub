import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
  });
}

describe("apresentação de datas no SoundOS", () => {
  it("não usa datas relativas, hora isolada nem ano de dois dígitos", () => {
    const violations = sourceFiles(join(process.cwd(), "src"))
      .filter((path) => path !== join(process.cwd(), "src/lib/date.ts"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return [
          /formatDistanceToNow|formatRelative|fromNow\(/.test(source) && "data relativa",
          /\.toLocaleTimeString\(/.test(source) && "hora sem data",
          /year:\s*["']2-digit["']|dd\/MM\/yy(?!yy)/.test(source) && "ano de dois dígitos",
        ].filter(Boolean).map((reason) => `${path}: ${reason}`);
      });

    expect(violations).toEqual([]);
  });
});