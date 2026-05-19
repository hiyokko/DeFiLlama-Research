# DeFiLlama Research

Discord notifier for new DL Research articles.

## What it does

- Checks the DL Research article list once per hour.
- Finds articles that have not been seen before.
- Summarizes each new article in Japanese with the OpenAI API.
- Sends the summary and article link to Discord through a webhook.

`defillama.com/research` is protected by Cloudflare in non-browser environments, so the notifier fetches the same DL Research article feed from `https://www.dlnews.com/research/`.

## GitHub setup

Add these repository secrets:

- `DISCORD_WEBHOOK_URL`
- `OPENAI_API_KEY`

Optional repository variable:

- `OPENAI_MODEL` defaults to `gpt-4.1-mini` when unset.

The workflow runs hourly and can also be started manually from GitHub Actions.

## Local test

Create `.env` from `.env.example`, then run:

```sh
npm run dry-run
```

To send a real Discord message locally:

```sh
npm run notify -- --force-latest 1
```
