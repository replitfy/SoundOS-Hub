import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const srcDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(srcDir, "App.tsx"), "utf8");
const layoutSource = readFileSync(resolve(srcDir, "components/layout.tsx"), "utf8");
const apiAdminSource = readFileSync(
  resolve(srcDir, "../../api-server/src/routes/admin.ts"),
  "utf8",
);

describe("simplified admin routes", () => {
  it.each(["catalogos", "conectores", "omie"])(
    "does not expose the %s admin page in routes or navigation",
    page => {
      expect(appSource).not.toContain(`/admin/${page}`);
      expect(layoutSource).not.toContain(`/admin/${page}`);
    },
  );

  it("keeps shared catalog APIs available to person records", () => {
    expect(apiAdminSource).toContain('router.get("/admin/catalogos/servicos"');
    expect(apiAdminSource).toContain('router.get("/admin/catalogos/instrumentos"');
  });
});