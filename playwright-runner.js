#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium, firefox, webkit, errors } = require('playwright');

function usage() {
  console.log('Usage: node scripts/playwright-runner.js <task.json>');
  process.exit(1);
}

const taskPath = process.argv[2];
if (!taskPath) usage();

const resolvedTaskPath = path.resolve(taskPath);
if (!fs.existsSync(resolvedTaskPath)) {
  console.error(`Task file not found: ${resolvedTaskPath}`);
  process.exit(1);
}

const task = JSON.parse(fs.readFileSync(resolvedTaskPath, 'utf8'));

const browserName = task.browser || 'chromium';
const browserMap = { chromium, firefox, webkit };
const browserType = browserMap[browserName];
if (!browserType) {
  console.error(`Unsupported browser: ${browserName}. Use chromium|firefox|webkit`);
  process.exit(1);
}

const headless = task.headless !== false;
const timeoutMs = task.timeoutMs || 30000;
const retries = Number.isInteger(task.retries) ? task.retries : 1;
const retryDelayMs = Number.isInteger(task.retryDelayMs) ? task.retryDelayMs : 500;
const outputDir = path.resolve(task.outputDir || 'scripts/playwright-output');
const allowSideEffects = task.allowSideEffects === true;
const schemaVersion = task.schemaVersion || 1;

fs.mkdirSync(outputDir, { recursive: true });

function nowIsoSafe() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeError(code, message, stage, details = undefined) {
  return { code, message, stage, details };
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost') return true;
  if (host.endsWith('.local')) return true;
  if (host.startsWith('127.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host === '::1') return true;
  return false;
}

function validatePolicy(urlString, taskObj) {
  const parsed = new URL(urlString);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Only http/https URLs are allowed: ${urlString}`);
  }

  const allowPrivate = taskObj.allowPrivateNetwork === true;
  if (!allowPrivate && isPrivateHostname(parsed.hostname)) {
    throw new Error(`Blocked private/local target: ${parsed.hostname}`);
  }

  const allowedDomains = Array.isArray(taskObj.allowedDomains) ? taskObj.allowedDomains : [];
  if (allowedDomains.length > 0) {
    const ok = allowedDomains.some((d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`));
    if (!ok) {
      throw new Error(`Domain not in allowedDomains: ${parsed.hostname}`);
    }
  }

  const blockedDomains = Array.isArray(taskObj.blockedDomains) ? taskObj.blockedDomains : [];
  if (blockedDomains.some((d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`))) {
    throw new Error(`Domain blocked by policy: ${parsed.hostname}`);
  }
}

function assertTaskShape(taskObj) {
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported schemaVersion: ${schemaVersion}. Expected 1.`);
  }

  if (!taskObj || typeof taskObj !== 'object') {
    throw new Error('Task must be an object');
  }

  if (!taskObj.url && !(taskObj.actions || []).some((a) => a.type === 'goto')) {
    throw new Error('Task must include top-level "url" or at least one goto action');
  }

  if (!Array.isArray(taskObj.actions)) {
    throw new Error('Task must include actions[]');
  }

  for (const [i, action] of taskObj.actions.entries()) {
    if (!action || typeof action !== 'object') throw new Error(`Action #${i + 1} must be an object`);
    if (!action.type) throw new Error(`Action #${i + 1} missing type`);
  }
}

function isRetryableError(err) {
  const msg = String(err?.message || '');
  return (
    err instanceof errors.TimeoutError ||
    msg.includes('Timeout') ||
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('Execution context was destroyed') ||
    msg.includes('strict mode violation')
  );
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt > retries || !isRetryableError(err)) {
        throw err;
      }
      console.warn(`Retrying ${label} (attempt ${attempt}/${retries + 1}) after error: ${err.message}`);
      await sleep(retryDelayMs);
    }
  }
  throw lastErr;
}

function resolveLocator(page, selectorSpec) {
  if (!selectorSpec) throw new Error('Missing selector');

  if (typeof selectorSpec === 'string') return page.locator(selectorSpec);

  if (selectorSpec.role) {
    const options = {};
    if (selectorSpec.name !== undefined) options.name = selectorSpec.name;
    if (selectorSpec.exact !== undefined) options.exact = !!selectorSpec.exact;
    return page.getByRole(selectorSpec.role, options);
  }

  if (selectorSpec.testId) return page.getByTestId(selectorSpec.testId);
  if (selectorSpec.css) return page.locator(selectorSpec.css);
  if (selectorSpec.xpath) return page.locator(`xpath=${selectorSpec.xpath}`);
  if (selectorSpec.text) return page.getByText(selectorSpec.text, { exact: !!selectorSpec.exact });

  throw new Error('Selector object must include one of: role, testId, css, xpath, text');
}

function enforceSideEffectPolicy(action, index) {
  if (action.sideEffect === true && !allowSideEffects) {
    throw new Error(
      `Blocked side-effect action #${index + 1} (${action.type}). Set task.allowSideEffects=true to allow.`
    );
  }
}

async function runAction(page, action, i, artifacts, extracted) {
  const label = `#${i + 1} ${action.type}`;

  await withRetry(async () => {
    switch (action.type) {
      case 'goto': {
        if (!action.url) throw new Error(`Action ${label} requires url`);
        validatePolicy(action.url, task);
        await page.goto(action.url, { waitUntil: action.waitUntil || 'domcontentloaded' });
        break;
      }
      case 'waitFor': {
        if (action.selector) {
          await resolveLocator(page, action.selector).first().waitFor(action.options || {});
        } else if (action.text) {
          await page.getByText(action.text).first().waitFor(action.options || {});
        } else if (action.ms) {
          await page.waitForTimeout(action.ms);
        } else {
          throw new Error(`Action ${label} requires selector, text, or ms`);
        }
        break;
      }
      case 'click': {
        await resolveLocator(page, action.selector).first().click(action.options || {});
        break;
      }
      case 'fill': {
        await resolveLocator(page, action.selector).first().fill(action.value ?? '');
        break;
      }
      case 'type': {
        await resolveLocator(page, action.selector).first().type(action.text ?? '', action.options || {});
        break;
      }
      case 'press': {
        if (!action.key) throw new Error(`Action ${label} requires key`);
        await resolveLocator(page, action.selector).first().press(action.key, action.options || {});
        break;
      }
      case 'select': {
        await resolveLocator(page, action.selector).first().selectOption(action.value, action.options || {});
        break;
      }
      case 'check': {
        await resolveLocator(page, action.selector).first().check(action.options || {});
        break;
      }
      case 'uncheck': {
        await resolveLocator(page, action.selector).first().uncheck(action.options || {});
        break;
      }
      case 'extract': {
        const key = action.as || `extract_${i + 1}`;
        const mode = action.mode || 'text';
        const locator = resolveLocator(page, action.selector).first();

        if (mode === 'text') extracted[key] = (await locator.innerText()).trim();
        else if (mode === 'html') extracted[key] = await locator.innerHTML();
        else if (mode === 'attr') extracted[key] = await locator.getAttribute(action.attr || 'href');
        else if (mode === 'allText') extracted[key] = await page.locator(action.selector?.css || action.selector).allInnerTexts();
        else throw new Error(`Unsupported extract mode: ${mode}`);
        break;
      }
      case 'screenshot': {
        const file = path.resolve(action.path || path.join(outputDir, `step-${i + 1}-${nowIsoSafe()}.png`));
        await page.screenshot({ path: file, fullPage: !!action.fullPage });
        artifacts.screenshots.push(file);
        break;
      }
      case 'evaluate': {
        if (!action.fn) throw new Error(`Action ${label} requires fn`);
        const key = action.as || `evaluate_${i + 1}`;
        extracted[key] = await page.evaluate(action.fn);
        break;
      }
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }, label);
}

async function run() {
  const runId = `${task.name || 'playwright-task'}-${nowIsoSafe()}`;
  const result = {
    ok: false,
    runId,
    schemaVersion,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stage: 'validate',
    data: {
      url: task.url || null,
      extracted: {},
      finalUrl: null,
      title: null,
      outputFormat: task.output?.format || 'json',
    },
    artifacts: {
      screenshots: [],
      html: null,
      resultJson: null,
    },
    error: null,
  };

  let browser, context, page;
  try {
    assertTaskShape(task);
    if (task.url) validatePolicy(task.url, task);

    result.stage = 'prepare';
    browser = await browserType.launch({ headless });
    context = await browser.newContext(task.context || {});
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    result.stage = 'navigate';
    if (task.url) {
      await withRetry(
        () => page.goto(task.url, { waitUntil: task.waitUntil || 'domcontentloaded' }),
        'initial navigation'
      );
    }

    result.stage = 'actions';
    const maxActions = Number.isInteger(task.maxActions) ? task.maxActions : 50;
    if (task.actions.length > maxActions) {
      throw new Error(`Too many actions (${task.actions.length}); maxActions=${maxActions}`);
    }

    for (const [i, action] of task.actions.entries()) {
      enforceSideEffectPolicy(action, i);
      await runAction(page, action, i, result.artifacts, result.data.extracted);
    }

    result.stage = 'collect';
    result.data.finalUrl = page.url();
    result.data.title = await page.title();

    const htmlPath = path.join(outputDir, `${runId}.html`);
    fs.writeFileSync(htmlPath, await page.content(), 'utf8');
    result.artifacts.html = htmlPath;

    if (task.captureFinalScreenshot !== false) {
      const finalShot = path.join(outputDir, `${runId}.png`);
      await page.screenshot({ path: finalShot, fullPage: true });
      result.artifacts.screenshots.push(finalShot);
    }

    result.ok = true;
    result.stage = 'done';
    return result;
  } catch (err) {
    result.ok = false;
    result.error = makeError('RUN_FAILED', String(err.message || err), result.stage, {
      name: err?.name,
    });

    if (page) {
      try {
        const failShot = path.join(outputDir, `${runId}-failure.png`);
        await page.screenshot({ path: failShot, fullPage: true });
        result.artifacts.screenshots.push(failShot);
      } catch (_e) {
        // ignore screenshot-on-failure error
      }
    }

    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    result.durationMs = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();

    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});

    const resultPath = path.join(outputDir, `${result.runId}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    result.artifacts.resultJson = resultPath;

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  }
}

run().catch((err) => {
  console.error('Runner bootstrap failed:', err);
  process.exit(1);
});
