#!/usr/bin/env node
/**
 * screenshot.mjs — capture the Chinese Web UI evidence for a CI session.
 *
 * Opens the `dsh web` server started by the verify workflow, opens the scenario
 * session in the sidebar (the UI has no deep link), waits for the plugin's row
 * text (`已精简工具调用结果` by default), and writes:
 *
 *   verify-chat-zh.png        full chat view showing the slimming row
 *   verify-chat-detail.png    the expanded/targeted row (best effort)
 *   verify-plugins.png        the Plugins panel with the plugin's bundle/toggle
 *
 * The UI is intentionally NOT a hard gate: if the row/panel is missing the
 * screenshots are still captured and the report records
 * `ui_assert_status: skipped-timeout`, matching the project decision that
 * unstable UI assertions must not fail the verification workflow. Log-level
 * assertions (`assert-slimming.mjs`) are the hard gate.
 *
 * Usage:
 *   node scripts/ci/screenshot.mjs --web-log "$RUNNER_TEMP/ci-artifacts/web.log"
 *   node scripts/ci/screenshot.mjs --url "http://127.0.0.1:1234/?token=..." --session-id session-...
 *   node scripts/ci/screenshot.mjs --dry-run
 *
 * Exit codes: 0 evidence captured (even with ui_assert_status=skipped-timeout),
 *             1 browser/navigation failure, 2 usage/setup error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_UI_TEXT = '已精简工具调用结果';

function parseArgs(argv) {
  const args = {
    url: process.env.DSH_WEB_URL ?? '',
    webLog: process.env.DSH_WEB_LOG ?? '',
    sessionId: process.env.SESSION_ID ?? '',
    artifactsDir: process.env.CI_ARTIFACTS_DIR ?? join(process.env.RUNNER_TEMP ?? '/tmp', 'ci-artifacts'),
    uiText: process.env.SLIMMER_UI_TEXT ?? DEFAULT_UI_TEXT,
    uiTextTimeoutMs: Number(process.env.SLIMMER_UI_TIMEOUT_MS ?? 45000),
    locale: process.env.SLIMMER_UI_LOCALE ?? 'zh-CN',
    pluginNames: (process.env.SLIMMER_PLUGIN_NAME ?? 'Context Slimmer').split(','),
    failOnMissingUiText: process.env.SLIMMER_FAIL_ON_MISSING_UI_TEXT === '1',
    requireSession: process.env.SLIMMER_REQUIRE_SESSION === '1',
    details: process.env.SLIMMER_DETAIL_SCREENSHOT !== '0',
    pluginsPanel: process.env.SLIMMER_PLUGINS_PANEL !== '0',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--url': args.url = next(); break;
      case '--web-log': args.webLog = next(); break;
      case '--session-id': args.sessionId = next(); break;
      case '--artifacts-dir': args.artifactsDir = next(); break;
      case '--ui-text': args.uiText = next(); break;
      case '--ui-text-timeout-ms': args.uiTextTimeoutMs = Number(next()); break;
      case '--locale': args.locale = next(); break;
      case '--plugin-name': args.pluginNames = next().split(','); break;
      case '--fail-on-missing-ui-text': args.failOnMissingUiText = true; break;
      case '--require-session': args.requireSession = true; break;
      case '--no-details': args.details = false; break;
      case '--no-plugins-panel': args.pluginsPanel = false; break;
      case '--dry-run': args.dryRun = true; break;
      case '-h': case '--help':
        process.stdout.write('see the header of scripts/ci/screenshot.mjs for usage\n');
        process.exit(0);
        break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const log = (message) => process.stdout.write(`screenshot: ${message}\n`);
const warn = (message) => process.stderr.write(`screenshot: WARNING: ${message}\n`);
const die = (message) => { process.stderr.write(`screenshot: ERROR: ${message}\n`); process.exit(2); };

/** Never let a URL's token leak into logs/artifacts. */
function sanitizeUrl(value) {
  return value.replace(/([?&](?:token|access_token)=)[^&]+/gi, '$1***');
}

function discoverUrl(args) {
  if (args.url) return args.url;
  if (args.webLog && existsSync(args.webLog)) {
    const lines = readFileSync(args.webLog, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/dsh web:\s*(https?:\/\/\S+)/);
      if (match) return match[1];
    }
  }
  return '';
}

async function loadPlaywright() {
  // Local resolution first (normal dev setup).
  for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
    try { return await import(name); } catch { /* try next */ }
  }
  // CI installs Playwright globally; ESM `import()` ignores NODE_PATH, so require
  // it from the global npm root explicitly (the packages are CJS-compatible).
  try {
    const { createRequire } = await import('node:module');
    const { spawnSync } = await import('node:child_process');
    const { join, dirname } = await import('node:path');
    const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
    if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
      const root = npmRoot.stdout.trim();
      const requireFromGlobal = createRequire(join(root, '.dsh-screenshot-resolver.cjs'));
      for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
        try { return requireFromGlobal(name); } catch { /* try next */ }
      }
    }
  } catch { /* fall through to undefined */ }
  return undefined;
}

// Notice/dialog buttons the Web UI can show on first launch (preview notice,
// sign-in, update banner). The preview notice in particular can be rendered
// *after* the first dismissal round, so this helper is also called while the
// script waits for the session to render.
const DISMISS_BUTTON_TEXT = /^(Continue|继续|Got it|知道了|Okay|好|Ok|Later|稍后|Close|关闭|Dismiss|跳过|Skip|开始使用|我已知晓|同意|Agree)$/i;

/**
 * Click every visible notice/dialog button once. Returns how many were clicked.
 * A present modal mask intercepts clicks, so fall back to Escape + force click.
 *
 * @param {import('playwright').Page} page Browser page.
 * @returns {Promise<number>} Number of dismissed buttons.
 */
async function dismissOverlaysOnce(page) {
  let clicked = 0;
  const buttons = page.getByRole('button').filter({ hasText: DISMISS_BUTTON_TEXT });
  const count = await buttons.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    try {
      await button.click({ timeout: 1500 });
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
      await button.click({ timeout: 1500, force: true }).catch(() => {});
    }
    clicked += 1;
    await page.waitForTimeout(250);
  }
  if (clicked === 0 && (await page.locator('[role="dialog"]:visible').count().catch(() => 0)) > 0) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    clicked = (await page.locator('[role="dialog"]:visible').count().catch(() => 0)) === 0 ? 1 : 0;
  }
  return clicked;
}

async function dismissNotices(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let dismissed = 0;
  while (Date.now() < deadline) {
    const before = dismissed;
    dismissed += await dismissOverlaysOnce(page);
    if (dismissed === before) {
      if ((await page.locator('[role="dialog"]:visible').count().catch(() => 0)) === 0) break;
      await page.waitForTimeout(250);
    }
  }
  return dismissed;
}

async function openScenarioSession(page, sessionId, artifactsDir) {
  if (sessionId) {
    const row = page.locator(`[role="treeitem"][data-row-key="session:${sessionId}"]`);
    if (await row.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)) {
      await row.click({ timeout: 5000 }).catch(() => {});
      return { status: 'opened-exact', selector: `session:${sessionId}` };
    }
    warn(`session row session:${sessionId} not found; trying the first visible session row`);
  }
  const anyRow = page.locator('[role="treeitem"][data-row-key^="session:"]').first();
  if (await anyRow.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
    const key = await anyRow.getAttribute('data-row-key').catch(() => null);
    await anyRow.click({ timeout: 5000 }).catch(() => {});
    return { status: 'opened-fallback', selector: key };
  }
  await page.screenshot({ path: join(artifactsDir, 'verify-sidebar-missing.png'), fullPage: true }).catch(() => {});
  return { status: 'missing', selector: null };
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { die(error.message); }
  mkdirSync(args.artifactsDir, { recursive: true });
  const report = {
    status: 'not-run',
    ui_assert_status: 'not-run',
    ui_text: args.uiText,
    session_id: args.sessionId || null,
    locale: args.locale,
    screenshots: [],
    pluginsPanel: { status: 'not-run', matchedName: null },
    consoleErrors: [],
    pageErrors: [],
    notes: [],
  };

  const url = discoverUrl(args);
  if (args.dryRun) {
    log('dry-run plan:');
    log(`  url: ${url ? sanitizeUrl(url) : '<missing: pass --url or --web-log>'}`);
    log(`  session id: ${args.sessionId || '<missing: pass --session-id>'}`);
    log(`  ui text: ${args.uiText} (timeout ${args.uiTextTimeoutMs}ms, non-fatal=${!args.failOnMissingUiText})`);
    log(`  locale: ${args.locale}`);
    log(`  screenshots: verify-chat-zh.png${args.details ? ', verify-chat-detail.png' : ''}${args.pluginsPanel ? ', verify-plugins.png' : ''}`);
    const playwright = await loadPlaywright();
    if (!playwright) {
      warn('playwright is not installed in this shell; the workflow installs it before this step');
      log('dry-run OK (with a warning: install with `npm i -g playwright && npx playwright install chromium`)');
      return;
    }
    log('dry-run OK (playwright resolvable; no browser launched)');
    return;
  }

  if (!url) die('no web URL: pass --url or --web-log with a line containing "dsh web: http://..."');
  if (!args.sessionId) warn('no --session-id: the first sidebar session row will be opened instead');

  const playwright = await loadPlaywright();
  if (!playwright) die('playwright is not installed; run `npm install -g playwright@1.64.1 && npx playwright install --with-deps chromium`');
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) die('loaded module has no chromium export');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: args.locale,
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on('pageerror', (error) => report.pageErrors.push(String(error).slice(0, 500)));

  try {
    log(`opening ${sanitizeUrl(url)}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (error) {
    await browser.close().catch(() => {});
    die(`could not open the web UI: ${error.message}`);
  }
  if (report.consoleErrors.length > 0) report.notes.push(`${report.consoleErrors.length} console error(s) captured before interaction`);

  const dismissed = await dismissNotices(page);
  if (dismissed > 0) log(`dismissed ${dismissed} startup notice(s)/dialog button(s)`);
  await page.waitForTimeout(1200);
  report.title = await page.title().catch(() => '');

  const session = await openScenarioSession(page, args.sessionId, args.artifactsDir);
  report.session = session;
  await page.waitForTimeout(600);
  // Opening the first session can trigger the preview notice; clear it again so
  // the conversation panel is not covered by the modal mask.
  const lateDismissed = await dismissNotices(page, 6000);
  if (lateDismissed > 0) log(`dismissed ${lateDismissed} late notice(s)/dialog button(s) after opening the session`);
  await page.waitForTimeout(1200);

  // The conversation panel loads persisted events; give it a moment to render.
  await page.waitForFunction(() => (document.body?.innerText ?? '').length > 400, undefined, { timeout: 30000 }).catch(() => {
    report.notes.push('conversation body stayed short; screenshots may show an empty state');
  });

  let uiTextFound = false;
  const started = Date.now();
  let lastDismissAttempt = 0;
  while (Date.now() - started < args.uiTextTimeoutMs) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (bodyText.includes(args.uiText)) {
      uiTextFound = true;
      break;
    }
    // A late preview/sign-in overlay blocks rendering below it; keep clearing it.
    if (Date.now() - lastDismissAttempt > 1500) {
      lastDismissAttempt = Date.now();
      const cleared = await dismissOverlaysOnce(page);
      if (cleared > 0) log(`cleared ${cleared} overlay(s) while waiting for the UI row text`);
    }
    await page.waitForTimeout(500);
  }
  if (uiTextFound) report.uiTextWaitMs = Date.now() - started;
  report.ui_assert_status = uiTextFound ? 'found' : 'skipped-timeout';
  if (!uiTextFound) {
    warn(`UI text "${args.uiText}" not found within ${args.uiTextTimeoutMs}ms; capturing screenshots anyway and marking ui_assert_status=skipped-timeout (non-fatal)`);
    report.notes.push('UI text not found; the log-level assertions remain the hard gate');
  } else {
    log(`UI text found: "${args.uiText}"`);
  }

  const chatPath = join(args.artifactsDir, 'verify-chat-zh.png');
  await page.screenshot({ path: chatPath, fullPage: true }).catch((error) => warn(`chat screenshot failed: ${error.message}`));
  report.screenshots.push('verify-chat-zh.png');

  if (args.details && uiTextFound) {
    const target = page.getByText(args.uiText, { exact: false }).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(args.artifactsDir, 'verify-chat-detail.png'), fullPage: true }).catch(() => {});
      report.screenshots.push('verify-chat-detail.png');
    }
  }

  if (args.pluginsPanel) {
    try {
      await dismissOverlaysOnce(page);
      const pluginsButton = page.getByRole('button', { name: /Plugins|插件/i }).first();
      const visible = await pluginsButton.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      if (visible) {
        await pluginsButton.click({ timeout: 5000 });
        await page.waitForTimeout(1600);
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const matchedName = args.pluginNames.find((name) => name && bodyText.includes(name)) ?? null;
        report.pluginsPanel = { status: matchedName ? 'found' : 'panel-open-name-missing', matchedName };
        await page.screenshot({ path: join(args.artifactsDir, 'verify-plugins.png'), fullPage: true }).catch(() => {});
        report.screenshots.push('verify-plugins.png');
        if (!matchedName) warn(`Plugins panel opened but none of [${args.pluginNames.join(', ')}] appear in its text`);
      } else {
        report.pluginsPanel = { status: 'button-missing', matchedName: null };
        warn('Plugins sidebar button not found; plugins panel screenshot skipped');
      }
    } catch (error) {
      report.pluginsPanel = { status: 'error', matchedName: null };
      warn(`plugins panel capture failed: ${error.message}`);
    }
  }

  await browser.close().catch(() => {});
  report.status = 'captured';
  report.url = sanitizeUrl(url);
  mkdirSync(args.artifactsDir, { recursive: true });
  writeFileSync(join(args.artifactsDir, 'screenshot-report.json'), JSON.stringify(report, undefined, 2) + '\n');
  log(`screenshots: ${report.screenshots.join(', ') || '<none>'}`);
  log(`ui_assert_status: ${report.ui_assert_status}; plugins: ${report.pluginsPanel.status}; session: ${report.session?.status}`);
  log(`report: ${join(args.artifactsDir, 'screenshot-report.json')}`);

  if (args.failOnMissingUiText && !uiTextFound) {
    die('UI text was not found and --fail-on-missing-ui-text was requested');
  }
  if (args.requireSession && report.session?.status === 'missing') {
    die('the scenario session was not visible in the sidebar and --require-session was requested');
  }
}

await main();
