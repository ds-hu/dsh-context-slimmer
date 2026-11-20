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
    uiTextTimeoutMs: Number(process.env.SLIMMER_UI_TIMEOUT_MS ?? 60000),
    locale: process.env.SLIMMER_UI_LOCALE ?? 'zh-CN',
    pluginNames: (process.env.SLIMMER_PLUGIN_NAME ?? 'Context Slimmer').split(','),
    failOnMissingUiText: process.env.SLIMMER_FAIL_ON_MISSING_UI_TEXT === '1',
    requireSession: process.env.SLIMMER_REQUIRE_SESSION === '1',
    details: process.env.SLIMMER_DETAIL_SCREENSHOT !== '0',
    pluginsPanel: process.env.SLIMMER_PLUGINS_PANEL !== '0',
    pluginConfig: process.env.SLIMMER_PLUGIN_CONFIG !== '0',
    configSelectors: (process.env.SLIMMER_CONFIG_SELECTORS
      ?? '[data-ctxslim-config],[data-field="everyNToolCalls"],[data-field="model.provider"],[data-field="model.maxOutputTokens"],[data-field*="reasoningEffort"],[data-ctxslim-save]').split(','),
    pluginRowTitles: (process.env.SLIMMER_PLUGIN_ROW_TITLES ?? '上下文精简器,context-slimmer-tool-result').split(','),
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
      case '--no-plugin-config': args.pluginConfig = false; break;
      case '--config-selectors': args.configSelectors = next().split(','); break;
      case '--plugin-row-title': args.pluginRowTitles = next().split(','); break;
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

/**
 * Click one sidebar session row and verify the conversation actually opened.
 * A late preview/sign-in overlay can intercept the click even though the modal
 * was already dismissed once, and Playwright's click() retries are cancelled by
 * the mask, so re-dismiss and retry a few times.
 *
 * @param {import('playwright').Page} page Browser page.
 * @param {import('playwright').Locator} row Session tree row.
 * @returns {Promise<boolean>} Whether the row reports itself selected.
 */
async function clickSessionRow(page, row) {
  const started = Date.now();
  for (let attempt = 0; attempt < 10 && Date.now() - started < 12000; attempt += 1) {
    await dismissOverlaysOnce(page);
    await page.waitForTimeout(attempt === 0 ? 300 : 800);
    if (attempt % 3 === 0) {
      try { await row.click({ timeout: 5000 }); }
      catch { await dismissOverlaysOnce(page); await row.click({ timeout: 5000, force: true }).catch(() => {}); }
    } else if (attempt % 3 === 1) {
      // Force click bypasses a lingering mask; the workspace restore may also
      // have re-rendered the row between attempts.
      await row.click({ timeout: 5000, force: true }).catch(() => {});
    } else {
      // Keyboard activation as a last resort for rows that swallow pointer events.
      await row.focus().catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(1000);
    await dismissOverlaysOnce(page);
    if ((await row.getAttribute('aria-selected').catch(() => null)) === 'true') {
      return { selected: true, selectedAfterMs: Date.now() - started };
    }
  }
  return { selected: false, selectedAfterMs: Date.now() - started };
}

/**
 * Wait until the sidebar session row set has not changed for two consecutive
 * one-second samples. The Web UI asynchronously restores the last workspace/
 * session after boot; clicking before that settles gets overwritten.
 *
 * @param {import('playwright').Page} page Browser page.
 * @param {number} [maxWaitMs] Maximum stabilization wait.
 * @returns {Promise<number>} Number of session rows when stable.
 */
async function waitForSidebarStable(page, maxWaitMs = 10000) {
  const started = Date.now();
  let previous = -1;
  let stableCount = 0;
  while (Date.now() - started < maxWaitMs) {
    const count = await page.locator('[role="treeitem"][data-row-key^="session:"]').count().catch(() => -1);
    if (count === previous) {
      stableCount += 1;
      if (stableCount >= 2) return count;
    } else {
      previous = count;
      stableCount = 0;
    }
    await page.waitForTimeout(1000);
  }
  return previous;
}

/**
 * Whether the conversation main area shows the opened session (not the blank
 * new-session composer). The sidebar alone is not proof: it is always present.
 *
 * @param {import('playwright').Page} page Browser page.
 * @returns {Promise<{opened: boolean, snippet: string}>} Main-area evidence.
 */
async function mainAreaShowsSession(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    const text = main?.textContent ?? '';
    const tabs = document.querySelectorAll('[role="tab"]').length;
    const opened = tabs >= 2 || /You are running a fixed|CI_SCENARIO_DONE|子智能体|Trajectory/.test(text) || text.length > 400;
    return { opened, snippet: (main?.innerText ?? text).slice(0, 500) };
  }).catch(() => ({ opened: false, snippet: '' }));
}

async function openScenarioSession(page, sessionId, artifactsDir, retriedReload = false) {
  const base = { retriedReload, pageUrl: sanitizeUrl(page.url()) };
  const attemptOpen = async (row, selectors) => {
    const result = await clickSessionRow(page, row);
    const main = await mainAreaShowsSession(page);
    return {
      ...base,
      ...selectors,
      selectedAfterMs: result.selectedAfterMs,
      selected: result.selected,
      mainOpened: main.opened,
      status: result.selected && main.opened ? 'opened-exact' : 'opened-but-blank',
    };
  };
  if (sessionId) {
    const row = page.locator(`[role="treeitem"][data-row-key="session:${sessionId}"]`);
    if (await row.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)) {
      const opened = await attemptOpen(row, { selector: `session:${sessionId}` });
      if (opened.status === 'opened-exact') return opened;
      if (!retriedReload) {
        // The async workspace restore can win the race once; a reload puts the
        // persisted selection on the same footing as a fresh click.
        warn('session did not open on the first pass; reloading the page once and retrying');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await dismissNotices(page, 6000);
        await waitForSidebarStable(page);
        return openScenarioSession(page, sessionId, artifactsDir, true);
      }
      return opened;
    }
    warn(`session row session:${sessionId} not found; trying the first visible session row`);
  }
  const anyRow = page.locator('[role="treeitem"][data-row-key^="session:"]').first();
  if (await anyRow.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
    const key = await anyRow.getAttribute('data-row-key').catch(() => null);
    const opened = await attemptOpen(anyRow, { selector: key });
    return opened.status === 'opened-exact' ? opened : { ...opened, status: 'opened-fallback' };
  }
  await page.screenshot({ path: join(artifactsDir, 'verify-sidebar-missing.png'), fullPage: true }).catch(() => {});
  return { ...base, status: 'missing', selector: null };
}

/**
 * Whether the slimmer UI row is present (DOM text, independent of visibility
 * heuristics) or the text appears anywhere in the rendered body.
 *
 * @param {import('playwright').Page} page Browser page.
 * @param {string} text Row title text.
 * @returns {Promise<boolean>} Whether the row/body carries the text.
 */
async function uiTextPresent(page, text) {
  return page.evaluate((needle) => {
    const rows = [...document.querySelectorAll('.ctxslim-row, [data-ctxslimmer-row]')];
    if (rows.some((row) => (row.textContent ?? '').includes(needle))) return true;
    const body = document.body;
    return (body?.innerText ?? '').includes(needle) || (body?.textContent ?? '').includes(needle);
  }, text).catch(() => false);
}


/**
 * The v0.2.0 planner is a direct LLM call, so the Web UI must not show the
 * "N 个子智能体" counter (its data source is the subagent catalog projection).
 *
 * @param {import('playwright').Page} page Browser page.
 * @returns {Promise<{status: string, matches: string[]}>} Counter evidence.
 */
async function inspectSubagentCounter(page) {
  const evidence = await page.evaluate(() => {
    const body = document.body;
    const text = body?.innerText ?? '';
    const matches = [];
    const pattern = /(\d+)\s*个子智能体/g;
    let match;
    while ((match = pattern.exec(text)) !== null) matches.push(match[0]);
    const textOccurrences = (text.match(/个子智能体/g) ?? []).length;
    return { matches, textOccurrences };
  }).catch(() => ({ matches: [], textOccurrences: 0 }));
  const matches = evidence.matches ?? [];
  const textOccurrences = evidence.textOccurrences ?? 0;
  if (matches.length === 0) {
    return textOccurrences === 0
      ? { status: 'absent', matches: [], textOccurrences }
      : { status: 'text-present', matches: [], textOccurrences };
  }
  const nonzero = matches.filter((value) => Number(value.match(/\d+/)?.[0] ?? 0) > 0);
  return { status: nonzero.length === 0 ? 'zero' : 'present', matches, textOccurrences };
}

/**
 * Open the native Plugins panel -> installed bundle detail -> module row detail
 * and assert the config form fields contributed by the v0.2.0 client half.
 *
 * @param {import('playwright').Page} page Browser page.
 * @param {object} args Parsed CLI args.
 * @param {object} report Screenshot report (mutated).
 */
async function capturePluginConfig(page, args, report) {
  const selectors = args.configSelectors.map((selector) => selector.trim()).filter(Boolean);
  const found = new Map(selectors.map((selector) => [selector, 0]));
  const countSelectors = async () => {
    for (const selector of selectors) {
      found.set(selector, await page.locator(selector).count().catch(() => 0));
    }
    return [...found.values()].every((count) => count > 0);
  };

  // 1) open the installed bundle's detail page from the plugins list.
  const pluginsButton = page.getByRole('button', { name: /Plugins|插件/i }).first();
  if (!(await pluginsButton.isVisible().catch(() => false))) {
    report.pluginConfig = { status: 'plugins-button-missing', selectors: [], screenshot: null };
    return;
  }
  if (!(await page.locator('[data-plugin-detail]').count().catch(() => 0))) {
    const namePattern = new RegExp(args.pluginNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
    // Prefer the installed-bundle card hook, then fall back to the title text.
    const card = page.locator('[data-plugin-package]').filter({ hasText: namePattern }).first();
    const target = (await card.count().catch(() => 0)) > 0 ? card : page.getByText(namePattern).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }
  const detailAvailable = await page.locator('[data-plugin-detail]').first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!detailAvailable) {
    report.pluginConfig = { status: 'bundle-detail-missing', selectors: [], screenshot: null };
    warn('plugins bundle detail did not open; plugin config screenshot skipped');
    return;
  }

  // 2) open the module row detail (the row carries data-plugin-row).
  const rowOpen = page.locator('[data-plugin-row]').first();
  if (await rowOpen.count().catch(() => 0)) {
    const rowButton = rowOpen.locator('button').first();
    const clicked = await rowButton.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!clicked) await rowOpen.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  let rowDetail = page.locator('[data-plugin-row-detail]').first();
  if (!(await rowDetail.count().catch(() => 0))) {
    // Fallback: click the localized module row title.
    for (const title of args.pluginRowTitles) {
      const hit = page.getByText(title, { exact: false }).first();
      if (await hit.isVisible().catch(() => false)) {
        await hit.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1200);
        rowDetail = page.locator('[data-plugin-row-detail]').first();
        if (await rowDetail.count().catch(() => 0)) break;
      }
    }
  }
  const hasConfig = await page.locator('[data-ctxslim-config]').count().catch(() => 0);
  const configStatus = await page.locator('[data-ctxslim-config]').first().getAttribute('data-ctxslim-status').catch(() => null);
  const configNoForm = (await page.locator('[data-ctxslim-config] [data-ctxslim-no-form], [data-ctxslim-no-form]').count().catch(() => 0)) > 0;
  const allDataFields = await page.evaluate(() => [...document.querySelectorAll('[data-field]')].map((node) => node.getAttribute('data-field')).filter(Boolean)).catch(() => []);
  const selectorsOk = await countSelectors();
  const missing = [...found.entries()].filter(([, count]) => count === 0).map(([selector]) => selector);
  const status = hasConfig > 0 && missing.length === 0
    ? 'found'
    : hasConfig === 0
      ? 'config-form-missing'
      : 'fields-missing';
  report.pluginConfig = {
    status,
    hasRowDetail: (await page.locator('[data-plugin-row-detail]').count().catch(() => 0)) > 0,
    configStatus,
    configNoForm,
    dataFields: allDataFields,
    selectors: [...found.entries()].map(([selector, count]) => ({ selector, count })),
    missing,
  };
  await page.screenshot({ path: join(args.artifactsDir, 'verify-plugin-config.png'), fullPage: true }).catch(() => {});
  report.screenshots.push('verify-plugin-config.png');
  report.pluginConfig.screenshot = 'verify-plugin-config.png';
  if (status !== 'found') warn(`plugin config form incomplete (${status}); missing: ${missing.join(', ') || '<form selector>'}`);
  else log('plugin config form found (all v0.2.0 fields present)');
  void selectorsOk;
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
    pluginConfig: { status: 'not-run', selectors: [], screenshot: null },
    subagentCounter: { status: 'not-run', matches: [], textOccurrences: 0 },
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
    log(`  screenshots: verify-chat-zh.png${args.details ? ', verify-chat-detail.png' : ''}${args.pluginsPanel ? ', verify-plugins.png' : ''}${args.pluginConfig ? ', verify-plugin-config.png' : ''}`);
    log(`  config selectors: ${args.configSelectors.join(' ')}`);
    log('  subagent counter check: N 个子智能体 must be absent');
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

  // The Web UI restores the last workspace/session asynchronously after boot;
  // clicking before the sidebar settles gets overwritten by that restore().
  const stableRows = await waitForSidebarStable(page);
  report.notes.push(`sidebar session rows stabilized at ${stableRows} before opening the session`);
  const session = await openScenarioSession(page, args.sessionId, args.artifactsDir);
  report.session = session;
  if (!session.selected || !session.mainOpened) {
    report.notes.push(`session did not open as requested: ${JSON.stringify(session).slice(0, 300)}`);
  }
  await page.waitForTimeout(600);
  // Opening the first session can trigger the preview notice; clear it again so
  // the conversation panel is not covered by the modal mask.
  const lateDismissed = await dismissNotices(page, 6000);
  if (lateDismissed > 0) log(`dismissed ${lateDismissed} late notice(s)/dialog button(s) after opening the session`);
  await page.waitForTimeout(1200);

  // The conversation panel loads persisted events; give it a moment to render.
  {
    const conversationDeadline = Date.now() + 20000;
    let conversationOpened = false;
    while (Date.now() < conversationDeadline) {
      const main = await mainAreaShowsSession(page);
      if (main.opened) { conversationOpened = true; break; }
      await dismissOverlaysOnce(page);
      await page.waitForTimeout(500);
    }
    if (!conversationOpened) {
      const main = await mainAreaShowsSession(page);
      report.notes.push(`conversation main area stayed blank; main text=${JSON.stringify(main.snippet.slice(0, 300))}`);
    }
  }

  let uiTextFound = false;
  const started = Date.now();
  let lastDismissAttempt = 0;
  let lastReopenAttempt = 0;
  while (Date.now() - started < args.uiTextTimeoutMs) {
    if (await uiTextPresent(page, args.uiText)) {
      uiTextFound = true;
      break;
    }
    // A late preview/sign-in overlay blocks rendering below it; keep clearing it.
    if (Date.now() - lastDismissAttempt > 1500) {
      lastDismissAttempt = Date.now();
      const cleared = await dismissOverlaysOnce(page);
      if (cleared > 0) log(`cleared ${cleared} overlay(s) while waiting for the UI row text`);
    }
    // The workspace restore may replace the main view with a blank session even
    // after a verified click; reopen the requested session instead of idling.
    if (Date.now() - lastReopenAttempt > 10000) {
      lastReopenAttempt = Date.now();
      const main = await mainAreaShowsSession(page);
      if (!main.opened && args.sessionId) {
        log('conversation turned blank while waiting; reopening the requested session');
        await openScenarioSession(page, args.sessionId, args.artifactsDir, true);
        report.notes.push('reopened the session while waiting for the UI row text');
      }
    }
    await page.waitForTimeout(500);
  }
  if (uiTextFound) report.uiTextWaitMs = Date.now() - started;
  report.ui_assert_status = uiTextFound ? 'found' : 'skipped-timeout';
  if (!uiTextFound) {
    warn(`UI text "${args.uiText}" not found within ${args.uiTextTimeoutMs}ms; capturing screenshots anyway and marking ui_assert_status=skipped-timeout (non-fatal)`);
    const main = await mainAreaShowsSession(page);
    report.notes.push(`UI text not found; main text=${JSON.stringify(main.snippet.slice(0, 300))}; the log-level assertions remain the hard gate`);
  } else {
    log(`UI text found: "${args.uiText}"`);
  }

  // Historical replay collapses tool activity by default: the slimmer row exists
  // in the DOM but is clipped inside the collapsed turn. Try to expand the turn
  // summary so the chat screenshot can paint the row; record the outcome either
  // way (the trajectory screenshot carries the visible evidence regardless).
  const rowLocator = page.locator('.ctxslim-row, [data-ctxslimmer-row]').first();
  let rowVisibleAfterExpand = false;
  let rowBoundingBox = null;
  const measureRow = async () => {
    const box = await rowLocator.boundingBox().catch(() => null);
    if (box === null || box.width <= 0 || box.height <= 0) return false;
    rowBoundingBox = box;
    // A nonzero bounding box is not enough: collapsed history keeps the row in
    // the layout but clips it behind an ancestor with height 0. Hit-test the row
    // centre to prove it is actually painted, and require it inside the viewport.
    const painted = await page.evaluate(() => {
      const row = document.querySelector('.ctxslim-row, [data-ctxslimmer-row]');
      if (row === null) return false;
      const rect = row.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const x = Math.min(window.innerWidth - 1, Math.max(0, rect.x + rect.width / 2));
      const y = Math.min(window.innerHeight - 1, Math.max(0, rect.y + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (row.contains(hit) || hit.closest('.ctxslim-row, [data-ctxslimmer-row]') === row);
    }).catch(() => false);
    rowVisibleAfterExpand = painted && box.y >= 0 && box.y + box.height <= 1000;
    return rowVisibleAfterExpand;
  };
  if (uiTextFound) {
    // A historical turn can render several collapsed activity groups (read,
    // failed command, web search, …); expand each distinct visible one until the
    // row paints or no further candidate appears.
    const expandText = /^(已完成，用时|Completed in|执行了|读取了|搜索了|运行了|已读取|已执行|已搜索|已运行|已调用|已写入|已获取|已发起)/;
    const clickedLabels = new Set();
    for (let round = 0; round < 8 && !rowVisibleAfterExpand; round += 1) {
      if (await measureRow()) break;
      const candidates = page.getByText(expandText);
      const count = await candidates.count().catch(() => 0);
      let clickedThisRound = false;
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const label = (await candidate.innerText().catch(() => '')).trim().slice(0, 80);
        if (label.length === 0 || clickedLabels.has(label)) continue;
        clickedLabels.add(label);
        await candidate.click({ timeout: 2500 }).catch(() => {});
        clickedThisRound = true;
        await page.waitForTimeout(700);
        if (await measureRow()) break;
      }
      if (!clickedThisRound) break;
    }
    // Also honour explicit disclosure controls (aria-expanded=false) when the
    // activity group is not discoverable by its label text.
    if (!rowVisibleAfterExpand) {
      const collapsed = page.locator('[aria-expanded="false"]').filter({ hasText: /已读取|已执行|已搜索|已运行|执行了|读取了|已完成，用时/ });
      const collapsedCount = await collapsed.count().catch(() => 0);
      for (let index = 0; index < collapsedCount && !rowVisibleAfterExpand; index += 1) {
        const control = collapsed.nth(index);
        if (!(await control.isVisible().catch(() => false))) continue;
        await control.click({ timeout: 2500 }).catch(() => {});
        await page.waitForTimeout(500);
        await measureRow();
      }
    }
    // Scroll (painted or not) so the screenshot targets the row's area.
    await page.evaluate(() => {
      document.querySelector('.ctxslim-row, [data-ctxslimmer-row]')?.scrollIntoView({ block: 'center' });
    }).catch(() => {});
    await page.waitForTimeout(700);
    if (!rowVisibleAfterExpand) await measureRow();
    report.session = {
      ...report.session,
      rowVisibleAfterExpand,
      rowBoundingBox: rowBoundingBox === null ? null : {
        x: Math.round(rowBoundingBox.x),
        y: Math.round(rowBoundingBox.y),
        width: Math.round(rowBoundingBox.width),
        height: Math.round(rowBoundingBox.height),
      },
    };
    if (!rowVisibleAfterExpand) {
      // Last-resort layout evidence: which ancestor clips the row to height 0.
      const paintChain = await page.evaluate(() => {
        const row = document.querySelector('.ctxslim-row, [data-ctxslimmer-row]');
        if (row === null) return null;
        const chain = [];
        let element = row;
        for (let depth = 0; depth < 7 && element !== null; depth += 1) {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          chain.push({
            tag: element.tagName,
            cls: String(element.className ?? '').slice(0, 80),
            h: Math.round(rect.height),
            display: style.display,
            overflow: style.overflow,
            visibility: style.visibility,
          });
          element = element.parentElement;
        }
        return chain;
      }).catch(() => null);
      report.notes.push(`slimmer row exists in the DOM but the replayed chat view clips collapsed tool activity; paint chain: ${JSON.stringify(paintChain)}; see verify-trajectory.png for the visible slimmed result`);
    }
  }

  report.subagentCounter = await inspectSubagentCounter(page);
  if (report.subagentCounter.status === 'present') {
    report.notes.push(`Web UI still shows a subagent counter: ${JSON.stringify(report.subagentCounter.matches)} (v0.2.0 planner must not create subagents)`);
    warn('Web UI shows a "N 个子智能体" counter; the v0.2.0 direct-LLM planner must not create subagents');
  } else if (report.subagentCounter.status === 'zero') {
    report.notes.push('Web UI subagent counter is visible but zero: ' + JSON.stringify(report.subagentCounter.matches));
  } else if (report.subagentCounter.status === 'text-present') {
    report.notes.push('Web UI contains 「个子智能体」 text without a counter; the v0.2.0 direct-LLM planner should not surface subagents');
    warn('Web UI contains 「个子智能体」 text');
  }

  const chatPath = join(args.artifactsDir, 'verify-chat-zh.png');
  await page.screenshot({ path: chatPath, fullPage: true }).catch((error) => warn(`chat screenshot failed: ${error.message}`));
  report.screenshots.push('verify-chat-zh.png');

  if (args.details && uiTextFound) {
    const row = page.locator('.ctxslim-row, [data-ctxslimmer-row]').first();
    const rowCount = await row.count().catch(() => 0);
    if (rowCount > 0) {
      // The chat list is virtualized: the row may exist in the DOM while being
      // outside the rendered scroll window, so scroll + activate it directly.
      await page.evaluate(() => {
        const rowElement = document.querySelector('.ctxslim-row, [data-ctxslimmer-row]');
        rowElement?.scrollIntoView({ block: 'center' });
        const button = rowElement?.querySelector('.ctxslim-button, [data-ctxslimmer-toggle]');
        if (button instanceof HTMLElement) button.click();
      }).catch(() => {});
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(args.artifactsDir, 'verify-chat-detail.png'), fullPage: true }).catch(() => {});
      report.screenshots.push('verify-chat-detail.png');
    } else {
      report.notes.push('slimmer row not present in the DOM when the detail screenshot was due');
    }
  }

  if (args.details && uiTextFound) {
    // Historical sessions paint tool activity collapsed in the chat view; the
    // trajectory tab renders the slimmed result itself (elided text), so keep a
    // second visual record of the event that the DOM assertion verified.
    try {
      const trajectoryTab = page.getByRole('tab', { name: /轨迹|Trajectory/i }).first();
      if (await trajectoryTab.isVisible().catch(() => false)) {
        await trajectoryTab.click({ timeout: 4000 });
        await page.waitForTimeout(1400);
        await page.screenshot({ path: join(args.artifactsDir, 'verify-trajectory.png'), fullPage: true }).catch(() => {});
        report.screenshots.push('verify-trajectory.png');
        const chatTab = page.getByRole('tab', { name: /对话|Chat/i }).first();
        if (await chatTab.isVisible().catch(() => false)) await chatTab.click({ timeout: 3000 }).catch(() => {});
      }
    } catch (error) {
      report.notes.push(`trajectory screenshot skipped: ${String(error).slice(0, 160)}`);
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
    if (args.pluginConfig && report.pluginsPanel.status !== 'button-missing') {
      try {
        await capturePluginConfig(page, args, report);
      } catch (error) {
        report.pluginConfig = { status: 'error', selectors: [], screenshot: null };
        warn(`plugin config capture failed: ${error.message}`);
      }
    }
  }

  await browser.close().catch(() => {});
  report.status = 'captured';
  report.url = sanitizeUrl(url);
  mkdirSync(args.artifactsDir, { recursive: true });
  writeFileSync(join(args.artifactsDir, 'screenshot-report.json'), JSON.stringify(report, undefined, 2) + '\n');
  log(`screenshots: ${report.screenshots.join(', ') || '<none>'}`);
  log(`ui_assert_status: ${report.ui_assert_status}; plugins: ${report.pluginsPanel.status}; pluginConfig: ${report.pluginConfig.status}; subagents: ${report.subagentCounter.status}; session: ${report.session?.status}`);
  log(`report: ${join(args.artifactsDir, 'screenshot-report.json')}`);

  if (args.failOnMissingUiText && !uiTextFound) {
    die('UI text was not found and --fail-on-missing-ui-text was requested');
  }
  if (args.requireSession && report.session?.status === 'missing') {
    die('the scenario session was not visible in the sidebar and --require-session was requested');
  }
}

await main();
