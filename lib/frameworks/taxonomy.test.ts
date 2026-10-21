import assert from "node:assert/strict";
import test from "node:test";
import { isFrameworkEntry } from "./entry-points";
import { categoriesForFramework, categoryForFile, type FileRole } from "./taxonomy";

test("categories keep concrete framework roles in reading order", () => {
  assert.deepEqual(categoriesForFramework("nextjs").slice(0, 3).map(category => category.label), ["Page routes", "API endpoints", "Server actions"]);
  assert.deepEqual(categoriesForFramework("nestjs").slice(0, 4).map(category => category.label), ["Controllers", "Services", "Modules", "Entities"]);
  assert.deepEqual(categoriesForFramework("generic").map(category => category.label), ["Source", "Tests", "Declarations"]);
  const roles: { file: string; role: FileRole }[] = [{ file: "src/user.controller.ts", role: "controller" }];
  assert.equal(categoryForFile("src/user.controller.ts", roles).id, "controller");
  assert.equal(categoryForFile("src/ordinary.ts", roles).id, "source");
  assert.equal(categoryForFile("src/user.spec.ts", roles).id, "test");
});

test("browser entry detection uses exact adapter facts and known entry roles", () => {
  const entries = ["packages/web/app/users/error.tsx", "packages/web/proxy.ts"];
  for (const file of entries) assert.equal(isFrameworkEntry("nextjs", file, [], entries), true);
  for (const file of ["app/users/error.tsx", "src/app/loading.tsx", "src/middleware.ts", "pages/_app.tsx",
    "lib/app/error.tsx", "lib/proxy.ts", "packages/web/nested/app/error.tsx"]) {
    assert.equal(isFrameworkEntry("nextjs", file, [], entries), false, file);
  }
  for (const framework of ["generic", "nestjs", "react"] as const) {
    assert.equal(isFrameworkEntry(framework, entries[0], [], entries), false);
  }
  assert.equal(isFrameworkEntry("nextjs", "app/page.tsx", [{ file: "app/page.tsx", role: "page" }], []), true);
  assert.equal(isFrameworkEntry("nestjs", "user.controller.ts", [{ file: "user.controller.ts", role: "controller" }], []), true);
  assert.equal(isFrameworkEntry("nestjs", "user.service.ts", [{ file: "user.service.ts", role: "service" }], []), false);
  assert.equal(isFrameworkEntry("nextjs", "app/error.test.tsx", [], ["app/error.test.tsx"]), false);
  assert.equal(isFrameworkEntry("nextjs", "app/error.d.ts", [], ["app/error.d.ts"]), false);
});
