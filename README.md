# DeFiLlama Research

Discord notifier for new DL Research articles.

## What it does

- Checks the DL Research article list once per day at 10:00 JST.
- Finds articles that have not been seen before.
- Summarizes each new article in Japanese with the OpenAI API.
- Sends the summary and article link to Discord through a webhook.

`defillama.com/research` is protected by Cloudflare in non-browser environments, so the notifier fetches the same DL Research article feed from `https://www.dlnews.com/research/`.

## GitHub setup

Add these repository secrets:

- `DISCORD_WEBHOOK_URL`

Optional repository secret:

- `OPENAI_API_KEY` enables AI-generated Japanese summaries. When unset, the workflow still sends a simple Japanese notification with an article excerpt.

Optional repository variable:

- `OPENAI_MODEL` defaults to `gpt-4.1-mini` when unset.

The workflow runs daily at 10:00 JST and can also be started manually from GitHub Actions.
When manually testing, set `force_latest` to `1` to send the latest article even if it is already marked as seen.

## Local test

Create `.env` from `.env.example`, then run:

```sh
npm run dry-run
```

To send a real Discord message locally:

```sh
npm run notify -- --force-latest 1
```
