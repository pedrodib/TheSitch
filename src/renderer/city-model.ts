import { deliveryKey, inPeriod, localDate } from '../shared/contributions';
import type { Contribution, Period, Repository } from '../shared/types';

export type Point = [number, number, number];
export type Face = { points: Point[]; color: string; repo?: string; ground?: boolean; normal: Point };
export const neon = ['#72e9f5', '#f59ae3', '#b6a4ed', '#ffc17b'];
const walls = ['#34334d', '#3c3857', '#303d53', '#44405d', '#36374e'];

/** Lots unlock gradually; low counts remain genuinely sparse and low-rise. */
export function districtDevelopment(works: number) {
  const thresholds = [1, 2, 4, 6, 9, 12, 16, 21, 27, 34, 42, 52, 65, 80, 100, 125];
  return {
    buildings: thresholds.filter((threshold) => works >= threshold).length,
    height: works <= 2 ? 5 + works * 2 : Math.min(135, 10 + Math.log2(1 + works / 3) * 13),
    stage:
      works === 0
        ? 'Terreno'
        : works <= 2
          ? 'Primeiras obras'
          : works < 12
            ? 'Vila neon'
            : works < 30
              ? 'Distrito'
              : works < 80
                ? 'Centro urbano'
                : 'Metrópole',
    pedestrians: works === 0 ? 0 : works <= 2 ? 1 : works < 12 ? 2 : 4,
  };
}

/** Stable blocks, independent of period. Height and infill grow with distinct deliveries. */
export function buildCity(
  repos: Repository[],
  contributions: Contribution[],
  period: Period,
  cutoff: string,
  timezone: string,
  historicalReplay = false,
) {
  const faces: Face[] = [];
  const labels: {
    repo: Repository;
    point: Point;
    count: number;
    commits: number;
    works: number;
    stage: string;
  }[] = [];
  const traffic: { start: Point; end: Point }[] = [];
  const walks: { repo: string; start: Point; end: Point; pedestrians: number }[] = [];
  const columns = Math.min(4, Math.max(2, repos.length));
  const rows = Math.max(2, Math.ceil(repos.length / columns));
  const pitch = 158;
  const left = (-columns * pitch) / 2;
  const back = (-rows * pitch) / 2;
  const face = (points: Point[], color: string, repo?: string, ground = false, normal?: Point) => {
    const [a, b, c] = points;
    const u = b.map((v, i) => v - a[i]),
      v = c.map((n, i) => n - a[i]);
    faces.push({
      points,
      color,
      repo,
      ground,
      normal: normal ?? [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
    });
  };
  const tile = (x: number, y: number, w: number, d: number, z: number, color: string, repo?: string) =>
    face(
      [
        [x, y, z],
        [x + w, y, z],
        [x + w, y + d, z],
        [x, y + d, z],
      ],
      color,
      repo,
      true,
    );
  const box = (
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
    color: string,
    repo?: string,
  ) => {
    face(
      [
        [x, y, z + h],
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
      '#58536d',
      repo,
    );
    face(
      [
        [x, y, z],
        [x + w, y, z],
        [x + w, y, z + h],
        [x, y, z + h],
      ],
      color,
      repo,
    );
    face(
      [
        [x + w, y, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x + w, y, z + h],
      ],
      '#26283f',
      repo,
    );
    face(
      [
        [x + w, y + d, z],
        [x, y + d, z],
        [x, y + d, z + h],
        [x + w, y + d, z + h],
      ],
      color,
      repo,
    );
    face(
      [
        [x, y + d, z],
        [x, y, z],
        [x, y, z + h],
        [x, y + d, z + h],
      ],
      '#2e3049',
      repo,
    );
  };
  // A continuous asphalt surface replaces the lagoon; the extended grid follows the camera.
  tile(left - 160, back - 160, columns * pitch + 320, rows * pitch + 320, -2, '#252139');
  for (let x = left - 160; x <= left + columns * pitch + 160; x += 20)
    tile(x, back - 160, 0.35, rows * pitch + 320, -1, '#4d3454');
  for (let y = back - 160; y <= back + rows * pitch + 160; y += 20)
    tile(left - 160, y, columns * pitch + 320, 0.35, -1, '#4d3454');
  for (let col = 0; col <= columns; col++) {
    const x = left + col * pitch - 12;
    tile(x, back - 24, 24, rows * pitch + 48, 0, '#292c43');
    for (let y = back - 20; y < back + rows * pitch + 20; y += 14) tile(x + 11.5, y, 0.6, 5, 0.1, '#6a627f');
    traffic.push({ start: [x + 7, back - 35, 1], end: [x + 7, back + rows * pitch + 35, 1] });
    traffic.push({ start: [x + 17, back + rows * pitch + 35, 1], end: [x + 17, back - 35, 1] });
  }
  for (let row = 0; row <= rows; row++) {
    const y = back + row * pitch - 12;
    tile(left - 24, y, columns * pitch + 48, 24, 0.2, '#292c43');
    for (let x = left - 20; x < left + columns * pitch + 20; x += 14)
      tile(x, y + 11.5, 5, 0.6, 0.3, '#6a627f');
    traffic.push({ start: [left - 35, y + 7, 1], end: [left + columns * pitch + 35, y + 7, 1] });
    traffic.push({ start: [left + columns * pitch + 35, y + 17, 1], end: [left - 35, y + 17, 1] });
  }
  for (let col = 0; col <= columns; col++)
    for (let row = 0; row <= rows; row++) {
      const x = left + col * pitch,
        y = back + row * pitch;
      for (let k = 0; k < 5; k++) {
        tile(x - 9 + k * 4, y + 15, 2, 6, 0.5, '#9892ad');
        tile(x + 15, y - 9 + k * 4, 6, 2, 0.5, '#9892ad');
      }
    }
  const tower = (
    x: number,
    y: number,
    h: number,
    w: number,
    d: number,
    seed: number,
    accent: string,
    repo?: string,
  ) => {
    const color = walls[seed % walls.length];
    box(x - 1, y - 1, 2, w + 2, d + 2, 3, '#4b475f', repo);
    box(x, y, 5, w, d, h, color, repo);
    // Inset rooftop, plant equipment and stepped crowns break the repeated box silhouette.
    box(x + 2, y + 2, h + 5, w - 4, d - 4, 2, '#39374f', repo);
    if (h >= 35 && seed % 3 !== 0)
      box(x + 5, y + 5, h + 7, w - 10, d - 10, seed % 3 === 1 ? 8 : 17, color, repo);
    if (h >= 24) box(x + 4, y + d - 8, h + 7, 6, 4, 3, '#45465c', repo);
    if (h >= 45 && seed % 4 === 0) box(x + w / 2, y + d / 2, h + 7, 1, 1, 17, accent, repo);
    for (let z = 10; z < h + 2; z += 7) {
      for (let c = 0; c < Math.floor((w - 4) / 5); c++) {
        const xx = x + 3 + c * 5;
        const light = (c * 7 + z + seed) % 5 < 2 ? accent : (c + z + seed) % 3 === 0 ? '#9993b3' : '#50536e';
        for (const yy of [y - 0.15, y + d + 0.15])
          face(
            [
              [xx, yy, z],
              [xx + 2, yy, z],
              [xx + 2, yy, z + 3],
              [xx, yy, z + 3],
            ],
            light,
            repo,
            false,
            [0, yy < y ? -1 : 1, 0],
          );
      }
      for (let c = 0; c < Math.floor((d - 4) / 5); c++) {
        const yy = y + 3 + c * 5;
        const light = (c + z + seed) % 4 === 0 ? accent : '#666780';
        for (const xx of [x - 0.15, x + w + 0.15])
          face(
            [
              [xx, yy, z],
              [xx, yy + 2, z],
              [xx, yy + 2, z + 3],
              [xx, yy, z + 3],
            ],
            light,
            repo,
            false,
            [xx < x ? -1 : 1, 0, 0],
          );
      }
    }
    // Vertical illuminated billboards, with individual glyph bars.
    if (h > 42) {
      box(x + w - 5, y - 1.2, 18, 4, 1, Math.min(24, h - 20), accent, repo);
      for (let z = 21; z < Math.min(40, h - 2); z += 5)
        face(
          [
            [x + w - 4, y - 1.3, z],
            [x + w - 2, y - 1.3, z],
            [x + w - 2, y - 1.3, z + 2],
            [x + w - 4, y - 1.3, z + 2],
          ],
          '#423249',
          repo,
        );
    }
  };
  repos.forEach((repo, i) => {
    const x = left + (i % columns) * pitch + 15,
      y = back + Math.floor(i / columns) * pitch + 15;
    const all = contributions.filter(
      (c) => c.repositoryId === repo.id && (!historicalReplay || localDate(c.occurredAt, timezone) <= cutoff),
    );
    const current = all.filter((c) => inPeriod(c, { start: period.start, end: cutoff }, timezone));
    const works = new Set(
      all
        .filter(
          (c) => c.kind === 'pull_request' || (c.kind === 'commit' && !c.associatedPullRequests?.length),
        )
        .map(deliveryKey),
    ).size;
    const development = districtDevelopment(works);
    const accent = works >= 12 ? neon[Math.floor(i / columns) % 2] : works >= 3 ? '#9976a4' : '#62576f';
    const commits = new Set(all.filter((c) => c.kind === 'commit').map((c) => c.externalId)).size;
    tile(x - 3, y - 3, 134, 134, 1, works >= 12 ? '#656079' : '#454052', repo.id);
    tile(x, y, 128, 128, 1.2, '#39364e', repo.id);
    // Sidewalks form a connected neon street network, with no water or bridges.
    for (const offset of [-3, 129]) {
      tile(x + offset, y - 3, 2, 134, 1.4, accent, repo.id);
      tile(x - 3, y + offset, 134, 2, 1.4, accent, repo.id);
    }
    for (let k = 0; k < 128; k += 8) {
      tile(x + k, y + 123, 0.5, 5, 1.5, '#82778d');
      tile(x + 123, y + k, 5, 0.5, 1.5, '#82778d');
    }
    const seed = [...repo.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
    for (let b = 0; b < 16; b++) {
      const bx = x + 6 + (b % 4) * 29,
        by = y + 6 + Math.floor(b / 4) * 27;
      if (b < development.buildings) {
        const n = (seed + b * 13) % 97;
        const lowRise = works <= 2;
        tower(
          bx,
          by,
          development.height * (lowRise ? 1 : 1 + (n % 5) * 0.1),
          lowRise ? 14 : 21 + (n % 3),
          lowRise ? 13 : 20 + (n % 2),
          n,
          neon[(i + b) % 4],
          repo.id,
        );
      } else {
        // Empty parcels are flat: no decorative structures that resemble earned buildings.
        tile(bx, by, 23, 22, 1.6, '#464158', repo.id);
        tile(bx + 1, by + 1, 21, 20, 1.7, '#302f46', repo.id);
      }
    }
    for (let k = 0; k < Math.min(18, commits); k++)
      box(x + 4 + k * 6.6, y + 117, 2, 4.5, 4, 3, neon[Math.floor(i / columns) % 2], repo.id);
    for (const dx of [0, 125]) {
      box(x + dx, y + 123, 2, 1, 1, works >= 12 ? 13 : 6, '#85819a', repo.id);
      box(x + dx - 2, y + 122, works >= 12 ? 15 : 8, 5, 2, 1, accent, repo.id);
    }
    labels.push({
      repo,
      point: [x + 64, y + 139, 3],
      count: current.length,
      commits,
      works,
      stage: development.stage,
    });
    walks.push({
      repo: repo.id,
      start: [x + 3, y + 124, 2],
      end: [x + 121, y + 124, 2],
      pedestrians: development.pedestrians,
    });
  });
  return { faces, labels, traffic, walks };
}
