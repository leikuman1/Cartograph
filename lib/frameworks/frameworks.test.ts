import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ts } from "ts-morph";
import { buildInsights, entryExclusionCounts } from "../canvas/insights";
import { isFrameworkEntry } from "./entry-points";
import { analyzeRepository } from "../parser";

async function analyzeFixture(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(tmpdir(), "cartograph-framework-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    return await analyzeRepository(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const nextPackage = JSON.stringify({ dependencies: { next: "16", react: "19" } });
const nestPackage = JSON.stringify({ dependencies: { "@nestjs/core": "11", "@nestjs/common": "11" } });
const nestMain = `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();`;
const nestModule = `import { Module } from '@nestjs/common';
import { CatsController } from './cats.controller';
@Module({ controllers: [CatsController] })
export class AppModule {}`;
const nestController = `import { Controller, Get, Post } from '@nestjs/common';
@Controller('cats')
export class CatsController {
  @Get(':id') find() { return {}; }
  @Post() create() { return {}; }
}`;

function nestFiles(main = nestMain, controller = nestController) {
  return { "package.json": nestPackage, "src/main.ts": main,
    "src/app.module.ts": nestModule, "src/cats.controller.ts": controller };
}

function routes(result: Awaited<ReturnType<typeof analyzeRepository>>) {
  return result.routes.map(({ file, method, path: route }) => [file, method, route]);
}

test("standalone parser detects Next before Nest and React, preserves custom module adapter and imports", async () => {
  const result = await analyzeFixture({
    "package.json": JSON.stringify({ dependencies: { next: "16", "@nestjs/core": "11", react: "19" } }),
    "app/page.tsx": "import { value } from '../lib/value'; export default function Page(){ return <p>{value}</p> }",
    "lib/value.ts": "export const value = 1;",
  });
  assert.equal(result.framework, "nextjs");
  assert.deepEqual(routes(result), [["app/page.tsx", "GET", "/"]]);
  assert.deepEqual(result.edges.map(edge => [edge.source, edge.target]), [["app/page.tsx", "lib/value.ts"]]);
  assert.deepEqual(result.fileRoles, [{ file: "app/page.tsx", role: "page" }]);
});

test("Next app routes keep groups, literal dynamic patterns, export aliases and source lines exact", async () => {
  const result = await analyzeFixture({
    "package.json": nextPackage,
    "next.config.ts": "const config = { cacheComponents: true, turbopack: {} }; export default config;",
    "src/app/(shop)/products/[id]/page.tsx": "export default function Page(){ return <p/> }",
    "src/app/(shop)/layout.tsx": "export default function Layout(){ return <main/> }",
    "src/app/api/[[...parts]]/route.ts": "const handler = () => new Response();\nexport { handler as POST };\nexport function GET() { return new Response(); }",
    "src/actions.ts": "'use server'; export async function save() {}",
    "src/inline.tsx": "export async function Component(){ async function save(){ 'use server'; } return <p/> }",
    "src/utils/page.tsx": "export default function Component(){ return <p/> }",
    "src/utils/route.ts": "export const GET = () => new Response();",
    "src/app/(.)modal/page.tsx": "export default function Modal(){ return <p/> }",
    "src/app/(..)photo/page.tsx": "export default function Modal(){ return <p/> }",
    "src/app/(..)/photo/page.tsx": "export default function Modal(){ return <p/> }",
    "src/app/@modal/route.ts": "export function GET() { return new Response(); }",
    "src/app/_private/page.tsx": "export default function Page(){ return <p/> }",
    "src/app/invalid/[bad/route.ts": "export function GET() {}",
    "src/app/demo/page.test.tsx": "export default function Page(){ return <p/> }",
    "src/globals.d.ts": "export interface Component {}",
  });
  assert.deepEqual(routes(result), [
    ["src/app/(shop)/products/[id]/page.tsx", "GET", "/products/[id]"],
    ["src/app/api/[[...parts]]/route.ts", "GET", "/api/[[...parts]]"],
    ["src/app/api/[[...parts]]/route.ts", "POST", "/api/[[...parts]]"],
  ]);
  assert.deepEqual(result.routes.map(route => route.line), [1, 3, 1]);
  assert.ok(result.fileRoles.some(item => item.file === "src/actions.ts" && item.role === "action"));
  assert.ok(result.fileRoles.some(item => item.file === "src/inline.tsx" && item.role === "action"));
  assert.ok(!result.fileRoles.some(item => item.file.endsWith(".test.tsx") || item.file.endsWith(".d.ts")));
  assert.equal(result.fileRoles.find(item => item.file === "src/utils/page.tsx")?.role, "component");
  assert.ok(!result.fileRoles.some(item => item.file === "src/utils/route.ts"));
});

test("Next pages routes support index, while pages API guards do not establish implemented methods", async () => {
  const result = await analyzeFixture({
    "package.json": nextPackage,
    "pages/index.tsx": "export default () => <p/>;",
    "pages/blog/[slug].tsx": "export default function Blog(){ return <p/> }",
    "pages/api/cats.ts": "export default function handler(req, res) { if (req.method === 'GET') return res.end(); switch(req.method) { case 'POST': return res.end(); } }",
    "pages/api/dynamic.ts": "export default function handler(req, res) { if(req.method === process.env.METHOD) return res.end(); }",
    "pages/_app.tsx": "export default () => <p/>;",
    "pages/_document.tsx": "export default () => <p/>;",
  });
  assert.deepEqual(routes(result), [
    ["pages/blog/[slug].tsx", "GET", "/blog/[slug]"],
    ["pages/index.tsx", "GET", "/"],
  ]);
});

test("Next route directories respect nearest package and root routing directory precedence", async () => {
  const result = await analyzeFixture({
    "package.json": "{}",
    "packages/web/package.json": nextPackage,
    "packages/web/app/page.tsx": "export default () => <p/>;",
    "packages/web/src/app/hidden/page.tsx": "export default () => <p/>;",
    "packages/web/pages/about.tsx": "export default () => <p/>;",
    "packages/web/src/pages/hidden.tsx": "export default () => <p/>;",
    "packages/web/nested/package.json": "{}",
    "packages/web/nested/app/page.tsx": "export default () => <p/>;",
    "packages/plain/package.json": "{}",
    "packages/plain/app/page.tsx": "export default () => <p/>;",
  });
  assert.equal(result.framework, "nextjs");
  assert.deepEqual(routes(result), [
    ["packages/web/app/page.tsx", "GET", "/"],
    ["packages/web/pages/about.tsx", "GET", "/about"],
  ]);
  assert.ok(!result.fileRoles.some(item => item.file.startsWith("packages/plain/") || item.file.startsWith("packages/web/nested/")));
});

test("Next special conventions are exact parsed entries, while ordinary modules remain unimported", async () => {
  const component = "export default function Component(){ return <p/> }";
  const entries = [
    "app/default.tsx", "app/error.tsx", "app/global-error.tsx", "app/global-not-found.tsx",
    "app/loading.tsx", "app/not-found.tsx", "app/template.tsx",
    "app/forbidden.tsx", "app/unauthorized.tsx", "app/account/forbidden.tsx",
    "app/(shop)/account/loading.tsx", "app/@modal/default.tsx", "app/(.)photo/error.tsx",
    "app/robots.ts", "app/manifest.ts", "app/sitemap.ts", "app/products/sitemap.ts",
    "pages/_app.tsx", "pages/_document.tsx", "pages/_error.tsx",
    "middleware.ts", "instrumentation.ts",
  ];
  const ordinary = ["lib/app/error.tsx", "lib/app/loading.tsx", "lib/proxy.ts", "lib/middleware.ts",
    "app/_private/error.tsx", "app/_private/sitemap.ts", "app/nested/robots.ts", "app/nested/manifest.ts",
    "app/nested/global-error.tsx", "app/nested/global-not-found.tsx", "pages/nested/_app.tsx"];
  const result = await analyzeFixture({
    "package.json": nextPackage,
    "next.config.ts": "export default { experimental: { authInterrupts: true, globalNotFound: true } };",
    ...Object.fromEntries([...entries, ...ordinary].map(file => [file, file === "middleware.ts"
      ? "export { handler as middleware } from './lib/handler';" : file === "instrumentation.ts"
        ? "export const enabled = true;" : file.endsWith(".ts") ? "export default function entry(){ return [] }" : component])),
    "lib/handler.ts": "export function handler() {}",
    "app/page.tsx": component,
    "app/layout.tsx": component,
    "app/api/route.ts": "export function GET() {}",
    "app/missing-export/error.tsx": "export const value = 1;",
    "app/reexport/error.tsx": "export { default } from '../../lib-component';",
    "lib-component.tsx": component,
    "app/ignored/error.tsx": component,
    ".gitignore": "app/ignored/\n",
    "app/error.test.tsx": component,
  });
  const expected = [...entries, "app/reexport/error.tsx"].sort();
  assert.deepEqual(result.frameworkEntries, expected);
  for (const file of [...expected, "app/page.tsx", "app/layout.tsx", "app/api/route.ts"]) {
    assert.equal(isFrameworkEntry(result.framework, file, result.fileRoles, result.frameworkEntries), true, file);
  }
  const insights = buildInsights(result.files, result.edges, result.framework, result.fileRoles, result.frameworkEntries);
  assert.ok(expected.every(file => !insights.unimported.some(item => item.path === file)));
  assert.ok(ordinary.every(file => insights.unimported.some(item => item.path === file)));
  assert.ok(insights.unimported.some(file => file.path === "app/missing-export/error.tsx"));
  const exclusions = entryExclusionCounts(result.files.filter(file => file.fanIn === 0), result.framework,
    result.fileRoles, result.frameworkEntries);
  assert.equal(exclusions["framework-entry"], expected.length + 3);
});

test("Next entries stay within the nearest Next package and active app, pages and hook roots", async () => {
  const component = "export default () => <p/>;";
  const entries = ["packages/web/app/error.tsx", "packages/web/app/robots.ts", "packages/web/pages/_app.tsx",
    "packages/web/proxy.ts", "packages/src-web/src/app/loading.tsx", "packages/src-web/src/pages/_document.tsx",
    "packages/src-web/src/middleware.ts", "packages/src-web/src/instrumentation.ts"];
  const ordinary = ["app/error.tsx", "proxy.ts", "packages/web/lib/app/error.tsx", "packages/web/lib/proxy.ts",
    "packages/web/src/app/error.tsx", "packages/web/src/pages/_app.tsx", "packages/web/src/proxy.ts",
    "packages/web/nested/app/error.tsx", "packages/web/nested/proxy.ts", "packages/plain/app/error.tsx",
    "packages/src-web/app-other/error.tsx", "packages/src-web/middleware.ts"];
  const result = await analyzeFixture({
    "package.json": "{}",
    "packages/web/package.json": nextPackage,
    "packages/web/nested/package.json": "{}",
    "packages/plain/package.json": "{}",
    "packages/src-web/package.json": nextPackage,
    ...Object.fromEntries([...entries, ...ordinary].map(file => [file,
      file.endsWith(".ts") ? "export default function entry(){ return [] }" : component])),
  });
  assert.deepEqual(result.frameworkEntries, [...entries].sort());
  const insights = buildInsights(result.files, result.edges, result.framework, result.fileRoles, result.frameworkEntries);
  assert.ok(ordinary.every(file => insights.unimported.some(item => item.path === file)));
});

test("Next metadata image variants allow only a single optional digit and require a default export", async () => {
  const images = ["icon", "apple-icon", "opengraph-image", "twitter-image"];
  const entries = images.flatMap(name => ["", "0", "9"].flatMap(number => ["app", "app/nested"]
    .map(directory => `${directory}/${name}${number}.tsx`)));
  const ordinary = images.flatMap(name => [`app/${name}10.tsx`, `app/${name}01.tsx`,
    `app/${name}-extra.tsx`, `app/no-export/${name}1.tsx`, `app/_private/${name}2.tsx`]);
  const result = await analyzeFixture({
    "package.json": nextPackage,
    ...Object.fromEntries([...entries, ...ordinary].map(file => [file, file.includes("/no-export/")
      ? "export function generateImageMetadata(){ return [] }" : "export default function image(){ return new Response() }"])),
    "app/robots.txt": "User-agent: *",
    "app/icon.png": "not a parsed source file",
  });
  assert.deepEqual(result.frameworkEntries, [...entries].sort());
  assert.ok(result.coverage.files.skippedFiles.some(file => file.path === "app/icon.png"));
});

test("Next experimental special entries require literal flags without executing config", async () => {
  const files = { "package.json": nextPackage, "app/forbidden.tsx": "export default () => <p/>;",
    "app/unauthorized.tsx": "export default () => <p/>;", "app/global-not-found.tsx": "export default () => <p/>;",
    "app/page.tsx": "export default () => <p/>;" };
  for (const config of [undefined, "export default {};", "export default {experimental: {authInterrupts: false, globalNotFound: false}};",
    "export default {experimental: {authInterrupts: process.env.ENABLED, globalNotFound: process.env.ENABLED}};",
    "export default {experimental: {...settings, authInterrupts: true, globalNotFound: true}};",
    "export default {experimental: {authInterrupts: true, globalNotFound: true, [key]: false}};",
    "export default withPlugin({experimental: {authInterrupts: true, globalNotFound: true}});"]) {
    const result = await analyzeFixture({ ...files, ...(config ? { "next.config.ts": config } : {}) });
    assert.deepEqual(result.frameworkEntries, [], config);
  }
  for (const config of [
    "const config = {experimental: {'authInterrupts': true, 'globalNotFound': true}}; export default config;",
    "module.exports = {experimental: {authInterrupts: true, globalNotFound: true}};",
  ]) {
    const result = await analyzeFixture({ ...files, "next.config.ts": config });
    assert.deepEqual(result.frameworkEntries, ["app/forbidden.tsx", "app/global-not-found.tsx", "app/unauthorized.tsx"]);
    assert.deepEqual(routes(result), [["app/page.tsx", "GET", "/"]]);
  }
});

test("Next path-changing and opaque config omits routes while retaining roles", async () => {
  for (const config of [
    "export default { basePath: '/docs' };",
    "export default { pageExtensions: ['page.tsx'] };",
    "export default { rewrites: async () => [] };",
    "export default withPlugin({});",
    "export default { ...settings };",
    "export default { 'basePath': '/docs' };",
    "const config = {}; config.basePath = '/docs'; export default config;",
    "module.exports = {}; Object.assign(module.exports, {basePath:'/docs'});",
  ]) {
    const result = await analyzeFixture({ "package.json": nextPackage,
      "next.config.ts": config, "app/page.tsx": "export default () => <p/>;" });
    assert.deepEqual(result.routes, [], config);
    assert.deepEqual(result.fileRoles, [{ file: "app/page.tsx", role: "page" }]);
  }
});

test("Nest uses actual aliased decorator bindings and literal global prefix plus path array combinations", async () => {
  const result = await analyzeFixture(nestFiles(
    nestMain.replace("NestFactory", "Factory").replace("import { Factory }", "import { NestFactory as Factory }")
      .replace("NestFactory.create", "Factory.create").replace("await app.listen", "app.setGlobalPrefix('/v1');\n  await app.listen"),
    `import { Controller as C, Get as Read, Post as Create } from '@nestjs/common';
@C(['cats', 'kittens'])
export class CatsController {
  @Read(['', ':id']) find() {}
  @Create('new') create() {}
}`,
  ));
  assert.equal(result.framework, "nestjs");
  assert.deepEqual(routes(result), [
    ["src/cats.controller.ts", "GET", "/v1/cats"],
    ["src/cats.controller.ts", "GET", "/v1/cats/:id"],
    ["src/cats.controller.ts", "GET", "/v1/kittens"],
    ["src/cats.controller.ts", "GET", "/v1/kittens/:id"],
    ["src/cats.controller.ts", "POST", "/v1/cats/new"],
    ["src/cats.controller.ts", "POST", "/v1/kittens/new"],
  ]);
  assert.deepEqual(result.routes.map(route => route.line), [4, 4, 4, 4, 5, 5]);
});

test("Nest normal bootstrap follows local module imports and never guesses fake decorators", async () => {
  const result = await analyzeFixture({
    ...nestFiles(),
    "src/app.module.ts": `import { Module } from '@nestjs/common'; import { CatsModule } from './cats.module';
@Module({imports: [CatsModule]}) export class AppModule {}`,
    "src/cats.module.ts": nestModule.replace("AppModule", "CatsModule"),
    "src/fake.controller.ts": "function Controller(...args: unknown[]) {return () => {}} function Get(...args: unknown[]) {return () => {}} @Controller('fake') export class FakeController { @Get() nope(){} }",
    "src/cats.service.ts": "export class CatsService {}",
    "src/cat.entity.ts": "export class Cat {}",
  });
  assert.deepEqual(routes(result), [["src/cats.controller.ts", "GET", "/cats/:id"], ["src/cats.controller.ts", "POST", "/cats"]]);
  assert.ok(result.fileRoles.some(item => item.role === "service"));
  assert.ok(result.fileRoles.some(item => item.role === "entity"));
});

test("Nest suppresses routes when bootstrap prefixes, router prefixes or URI versions are uncertain", async () => {
  for (const main of [
    nestMain.replace("await app.listen", "app.setGlobalPrefix(process.env.PREFIX); await app.listen"),
    nestMain.replace("await app.listen", "if (process.env.PREFIX) app.setGlobalPrefix('api'); await app.listen"),
    nestMain.replace("await app.listen", "app.enableVersioning({ type: 0 }); await app.listen"),
    nestMain.replace("await app.listen(3000);", "await app.listen(3000); app.setGlobalPrefix('late');"),
    nestMain.replace("NestFactory.create(AppModule)", "NestFactory.create(AppModule, customAdapter)"),
    "export const bootstrap = externalBootstrap;",
    nestMain + "\nimport { RouterModule } from '@nestjs/core'; RouterModule.register([{path:'api', module: AppModule}]);",
  ]) {
    const result = await analyzeFixture(nestFiles(main));
    assert.deepEqual(result.routes, [], main);
    assert.ok(result.fileRoles.some(item => item.role === "controller"));
  }
});

test("Nest omits computed controller/method paths, versioned, custom and All handlers", async () => {
  for (const controller of [
    nestController.replace("@Controller('cats')", "@Controller(process.env.PREFIX)"),
    nestController.replace("@Get(':id')", "@Get(dynamic)").replace("@Post()", "@Post(dynamic)"),
    nestController.replace("Controller, Get, Post", "Controller, Get, Post, Version").replace("@Controller('cats')", "@Version('1') @Controller('cats')"),
    nestController.replace("Controller, Get, Post", "Controller, Get, Post, All").replace("@Get(':id')", "@All(':id')").replace("@Post()", "@All()"),
    nestController.replace("@Get(':id')", "@Custom() @Get(':id')").replace("@Post()", "@Custom() @Post()"),
    nestController.replace("@Controller('cats')", "@Controller('cats/id:bad')"),
  ]) {
    const result = await analyzeFixture(nestFiles(nestMain, controller));
    assert.deepEqual(result.routes, [], controller);
  }
});

test("React is detected from imports, roles require evidence, and generic fallback has no routes", async () => {
  const result = await analyzeFixture({
    "src/component.tsx": "import { useState } from 'react'; export function Counter(){ return <p/> }",
    "src/useValue.ts": "import { useState } from 'react'; export function useValue(){ return useState(0) }",
    "src/Component.ts": "export const Component = 1;",
    "src/utils/page.ts": "export const page = 1;",
  });
  assert.equal(result.framework, "react");
  assert.deepEqual(result.fileRoles, [{ file: "src/component.tsx", role: "component" }, { file: "src/useValue.ts", role: "hook" }]);
  assert.deepEqual(result.routes, []);
  assert.deepEqual(result.frameworkEntries, []);
  const generic = await analyzeFixture({ "package.json": "not json", "app/page.tsx": "export default () => <p/>;" });
  assert.equal(generic.framework, "generic");
  assert.deepEqual(generic.fileRoles, []);
  assert.deepEqual(generic.routes, []);
  assert.deepEqual(generic.frameworkEntries, []);
  const nest = await analyzeFixture({ "package.json": JSON.stringify({ dependencies: { "@nestjs/core": "11", react: "19" } }) });
  assert.equal(nest.framework, "nestjs");
  assert.deepEqual(nest.frameworkEntries, []);
});

test("framework manifest reads stay confined and never follow package symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cartograph-framework-boundary-"));
  const outside = await mkdtemp(path.join(tmpdir(), "cartograph-framework-outside-"));
  const original = ts.sys.readFile;
  const reads: string[] = [];
  try {
    await writeFile(path.join(outside, "package.json"), nextPackage);
    await symlink(outside, path.join(root, "linked"), "junction");
    await mkdir(path.join(root, "app"));
    await writeFile(path.join(root, "app/page.tsx"), "export default () => <p/>;");
    ts.sys.readFile = (file, encoding) => { reads.push(file); return original(file, encoding); };
    const result = await analyzeRepository(root, { adapter: { moduleForFile: () => "custom" } });
    assert.equal(result.framework, "generic");
    assert.equal(result.files[0].module, "custom");
    assert.ok(!reads.some(file => file.includes(outside) || path.resolve(file) === path.join(root, "package.json")));
  } finally {
    ts.sys.readFile = original;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
