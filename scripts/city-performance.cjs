// CPU-only reproducible benchmark. Does not estimate Electron FPS, GPU time or total app memory.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, file);
const root = path.resolve(__dirname, '..');
const { buildCity } = require(path.join(root, 'src/renderer/city-model.ts'));
const { projectCity } = require(path.join(root, 'src/renderer/city-renderer.tsx'));
const { createDemoData } = require(path.join(root, 'src/backend/demo.ts'));
const { defaultConfig } = require(path.join(root, 'src/shared/defaults.ts'));
const base = createDemoData(defaultConfig('/tmp'));
const repos = Array.from({ length: 8 }, (_, i) => ({ ...base.repositories[0], id: `repo-${i}` }));
const contributions = repos.flatMap(repo => Array.from({ length: 40 }, (_, i) => ({ ...base.contributions[0], id: `${repo.id}-${i}`, externalId: `${i}`, kind: 'pull_request', repositoryId: repo.id, occurredAt: '2026-11-05T12:00:00Z' })));
const model = buildCity(repos, contributions, { start: '2026-11-01', end: '2026-11-05' }, '2026-11-05', 'UTC');
const angle = -.72;
function oldFrame() {
  const depth = f => f.points.reduce((sum, [x, y, z]) => sum + x * Math.sin(angle) + y * Math.cos(angle) + z * .02, 0) / f.points.length;
  return model.faces.filter(f => !f.ground && f.normal[0] * Math.sin(angle) + f.normal[1] * Math.cos(angle) + f.normal[2] * .5 > 0).sort((a,b) => depth(a) - depth(b)).map(f => ({key:f.points.flat().join(':'), points:f.points.map(([x,y,z])=>[600+(x*Math.cos(angle)-y*Math.sin(angle))*1.32,465+(x*Math.sin(angle)+y*Math.cos(angle))*.66-z*1.32].join(',')).join(' ')}));
}
function sample(fn) {
  for(let i=0;i<3;i++) fn();
  const samples=[];
  for(let i=0;i<15;i++) {const start=performance.now();fn();samples.push(performance.now()-start);}
  return Number(samples.sort((a,b)=>a-b)[7].toFixed(2));
}
const projected=projectCity(model.faces,angle);
console.log(JSON.stringify({scenario:'8 synthetic districts, 40 PRs each', worldFaces:model.faces.length, visibleFaces:projected.ground.length+projected.buildings.length, oldSvgPreparationMedianMs:sample(oldFrame), newProjectionMedianMs:sample(()=>projectCity(model.faces,angle)), staticGeometryDomNodesBefore:projected.ground.length+projected.buildings.length, staticGeometryDomNodesAfter:4, notes:'New projection runs only on geometry/rotation changes. Timings exclude browser rasterization and React.'},null,2));
