import assert from "node:assert/strict";
import test from "node:test";
import { isFrameworkEntry } from "./entry-points";
import {
  categoriesForFramework, categoryForFile, frameworkSupportsEntries, frameworkSupportsRoutes, type FileRole,
} from "./taxonomy";

test("categories keep concrete framework roles in reading order", () => {
  assert.deepEqual(categoriesForFramework("nextjs").slice(0, 3).map(category => category.label), ["Page routes", "API endpoints", "Server actions"]);
  assert.deepEqual(categoriesForFramework("nestjs").slice(0, 4).map(category => category.label), ["Controllers", "Services", "Modules", "Entities"]);
  assert.deepEqual(categoriesForFramework("express").map(category => category.label),
    ["Routes", "Controllers", "Middleware", "Services", "Models", "Source", "Tests", "Declarations"]);
  assert.deepEqual(categoriesForFramework("generic").map(category => category.label), ["Source", "Tests", "Declarations"]);
  const roles: { file: string; role: FileRole }[] = [{ file: "src/user.controller.ts", role: "controller" }];
  assert.equal(categoryForFile("src/user.controller.ts", roles).id, "controller");
  assert.equal(categoryForFile("src/ordinary.ts", roles).id, "source");
  assert.equal(categoryForFile("src/user.spec.ts", roles).id, "test");
});

test("Express directory roles stay distinct while tests and declarations retain their categories", () => {
  const roles: { file: string; role: FileRole }[] = [
    { file: "src/routes/users.ts", role: "route" },
    { file: "src/middlewares/auth.ts", role: "middleware" },
    { file: "src/models/user.ts", role: "model" },
    { file: "src/routes/users.test.ts", role: "route" },
    { file: "src/models/user.d.ts", role: "model" },
  ];
  assert.equal(categoryForFile(roles[0].file, roles).id, "route");
  assert.equal(categoryForFile(roles[1].file, roles).id, "middleware");
  assert.equal(categoryForFile(roles[2].file, roles).id, "model");
  assert.equal(categoryForFile(roles[3].file, roles).id, "test");
  assert.equal(categoryForFile(roles[4].file, roles).id, "declaration");
  assert.equal(frameworkSupportsRoutes("express"), false);
  assert.equal(frameworkSupportsEntries("express"), false);
});

test("browser entry detection uses exact adapter facts and known entry roles", () => {
  const entries = ["packages/web/app/users/error.tsx", "packages/web/proxy.ts"];
  for (const file of entries) assert.equal(isFrameworkEntry("nextjs", file, [], entries), true);
  for (const file of ["app/users/error.tsx", "src/app/loading.tsx", "src/middleware.ts", "pages/_app.tsx",
    "lib/app/error.tsx", "lib/proxy.ts", "packages/web/nested/app/error.tsx"]) {
    assert.equal(isFrameworkEntry("nextjs", file, [], entries), false, file);
  }
  for (const framework of ["generic", "nestjs", "express", "react"] as const) {
    assert.equal(isFrameworkEntry(framework, entries[0], [], entries), false);
  }
  assert.equal(isFrameworkEntry("nextjs", "app/page.tsx", [{ file: "app/page.tsx", role: "page" }], []), true);
  assert.equal(isFrameworkEntry("nestjs", "user.controller.ts", [{ file: "user.controller.ts", role: "controller" }], []), true);
  assert.equal(isFrameworkEntry("nestjs", "user.service.ts", [{ file: "user.service.ts", role: "service" }], []), false);
  for (const role of ["route", "controller", "middleware", "service", "model"] as const) {
    const file = `src/${role}/users.ts`;
    assert.equal(isFrameworkEntry("express", file, [{ file, role }], [file]), false, role);
  }
  assert.equal(isFrameworkEntry("nextjs", "app/error.test.tsx", [], ["app/error.test.tsx"]), false);
  assert.equal(isFrameworkEntry("nextjs", "app/error.d.ts", [], ["app/error.d.ts"]), false);
});
