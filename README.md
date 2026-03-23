# Playwright Tool-Call Pipeline (v1)

Use this when web-agent style browsing is required.

## Entrypoint

```bash
bash scripts/pw-run.sh <task.json>
# or
node scripts/playwright-runner.js <task.json>
```

## Task contract

- Schema file: `scripts/playwright-task.schema.json`
- Example: `scripts/playwright-task.example.json`
- Required:
  - `schemaVersion: 1`
  - `actions: []`
  - `url` (or first action can be `goto`)

## Safety defaults

- Side effects blocked unless `allowSideEffects: true`
- Private/local targets blocked unless `allowPrivateNetwork: true`
- Optional domain policy:
  - `allowedDomains: ["example.com"]`
  - `blockedDomains: ["..."]`
- Max actions default: `50`

## Outputs

Each run writes under `scripts/playwright-output/`:

- `<runId>.json` structured result envelope
- `<runId>.html` final page html snapshot
- `<runId>.png` final screenshot (unless disabled)
- optional step screenshots

Result envelope includes:

- `ok`
- `stage`
- `data` (`finalUrl`, `title`, `extracted`)
- `artifacts`
- `error` (typed failure payload)

## Typical use in assistant flow

1. Generate a task json file for the user request.
2. Run pipeline with `bash scripts/pw-run.sh <task.json>`.
3. Parse `<runId>.json` and respond with extracted data + artifact paths.
