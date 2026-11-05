// Export the production city geometry with synthetic contributions only.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, file);
}
const root = path.resolve(__dirname, '../..');
const { buildCity } = require(path.join(root, 'src/renderer/city-model.ts'));
const { projectCity } = require(path.join(root, 'src/renderer/city-renderer.tsx'));
const names = ['launchpad', 'design-system', 'event-stream', 'cloud-api', 'core-engine', 'control-center'];
const counts = [2, 8, 18, 38, 72, 130];
const repositories = names.map((name, i) => ({ id: `demo-${i}`, workspaceId: 'demo', name, fullName: `demo/${name}`, url: '' }));
const contributions = repositories.flatMap((repo, i) => Array.from({ length: counts[i] }, (_, n) => ({
  id: `${repo.id}-${n}`, workspaceId: 'demo', memberId: 'demo', repositoryId: repo.id,
  source: 'github', externalId: String(n), kind: 'pull_request', title: 'Synthetic delivery', body: '', url: '',
  occurredAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:00Z', state: 'merged', additions: 20, deletions: 4, participants: ['demo'], labels: [],
})));
const city = buildCity(repositories, contributions, { start: '2026-01-01', end: '2026-11-01' }, '2026-11-01', 'UTC');
const frames = Array.from({ length: 96 }, (_, i) => {
  const t = i / 96;
  const angle = -.72 + .48 * Math.sin(t * Math.PI * 2);
  const zoom = 1 + .18 * (1 - Math.cos(t * Math.PI * 2)) / 2;
  const projected = projectCity(city.faces, angle);
  const point = (p) => { const [x,y] = projected.project(p); return [(x - 600) * zoom * .60 + 480, (y - 400) * zoom * .60 + 337]; };
  return {
    zoom, angle,
    faces: [...projected.ground, ...projected.buildings].map(f => ({ color: f.color, points: f.points.map(([x,y]) => [(x - 600) * zoom * .60 + 480, (y - 400) * zoom * .60 + 337]) })),
    labels: city.labels.map(l => ({ name: l.repo.name, count: l.count, point: point(l.point) })),
    cars: city.traffic.flatMap((lane, j) => [0, .5].map(offset => { const progress = (t * 2 + j * .13 + offset) % 1; return point(lane.start.map((v,k) => v + (lane.end[k] - v) * progress)); })),
  };
});
process.stdout.write(JSON.stringify({ frames, total: counts.reduce((a,b) => a+b, 0) }));
