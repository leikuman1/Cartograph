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

test("special framework entries require the framework and directory boundary", () => {
  assert.equal(isFrameworkEntry("nextjs", "app/users/error.tsx", []), true);
  assert.equal(isFrameworkEntry("nextjs", "src/app/loading.tsx", []), true);
  assert.equal(isFrameworkEntry("nextjs", "src/middleware.ts", []), true);
  assert.equal(isFrameworkEntry("nextjs", "pages/_app.tsx", []), true);
  assert.equal(isFrameworkEntry("nextjs", "src/utils/error.ts", []), false);
  assert.equal(isFrameworkEntry("nextjs", "lib/layout.ts", []), false);
  assert.equal(isFrameworkEntry("generic", "app/users/error.tsx", []), false);
  assert.equal(isFrameworkEntry("nestjs", "user.controller.ts", [{ file: "user.controller.ts", role: "controller" }]), true);
  assert.equal(isFrameworkEntry("nestjs", "user.service.ts", [{ file: "user.service.ts", role: "service" }]), false);
});
