import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('cidade, dados demonstrativos, filtros e configurações no Electron real', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'thesitch-e2e-'));
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, THESITCH_DATA_DIR: dataDir, THESITCH_DEMO: '1', NODE_ENV: 'test' },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('body')).toContainText('NEON CITY');
    await page.waitForFunction(() => Boolean(window.theSitch));
    const config = await page.evaluate(() => window.theSitch.getConfig());
    config.onboardingComplete = true;
    await page.evaluate((value) => window.theSitch.saveConfig(value), config);
    await page.reload();
    await expect(page.locator('svg.city')).toBeVisible();
    await expect(page.locator('body')).toContainText(/demonstração|demo/i);
    await expect(page.locator('.district-marker').first()).toBeVisible();
    await page.locator('.district-marker').first().click();
    await page.screenshot({ path: 'test-results/cyberpunk-desktop.png', fullPage: true });
    const dashboard = await page.evaluate(async () => {
      const today = new Date().toISOString().slice(0, 10);
      const earlier = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      return window.theSitch.getDashboard({ start: earlier, end: today });
    });
    expect(dashboard.demo).toBe(true);
    expect(dashboard.repositories.length).toBeGreaterThan(0);
    expect(dashboard.metrics.deliveries).toBeGreaterThan(0);
    expect(dashboard.metrics.tokens).toBeGreaterThan(0);
    const actual = await page.evaluate(async () => {
      await window.theSitch.setDemo(false);
      const today = new Date().toISOString().slice(0, 10);
      return window.theSitch.getDashboard({ start: today, end: today });
    });
    expect(actual.demo).toBe(false);
    expect(actual.metrics.deliveries).toBe(0);
    await page.evaluate(() => window.theSitch.setDemo(true));
    await page.reload();
    await page
      .getByRole('button', { name: /configurações/i })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(errors).toEqual([]);
    await expect(
      page.evaluate(async () => {
        try {
          await window.theSitch.openExternal('file:///etc/passwd');
          return true;
        } catch {
          return false;
        }
      }),
    ).resolves.toBe(false);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(
      false,
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
