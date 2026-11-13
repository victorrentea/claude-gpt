# claude-gpt

Run the **Claude Code CLI** on OpenAI's **Codex models**, paid by your **ChatGPT subscription**
(Plus/Pro), not by API credit.

```bash
claude-gpt            # the usual Claude Code: same TUI, tools, skills, hooks, sessions
                      # ...but the model answering is gpt-6-astra
```

Requests go to the same backend the `codex` CLI uses
(`https://chatgpt.com/backend-api/codex/responses`) and count against your subscription quota.
The Anthropic → OpenAI translation is done by
[`claude-code-router`](https://github.com/musistudio/claude-code-router) (CCR 2.x) plus a custom
transformer, [`codex.js`](codex.js).

## Install

Needs Node, the `claude` CLI and the `codex` CLI on your `PATH`.

```bash
git clone https://github.com/victorrentea/claude-gpt.git && cd claude-gpt
npm install
ln -s "$PWD/codex-gpt" ~/.local/bin/claude-gpt   # any dir on your PATH; the name is up to you
claude-gpt login      # once: ChatGPT login in the browser, a session of its own in ~/.codex-gpt
```

Until you run `claude-gpt login`, the transformer borrows the `codex` CLI's token
(`~/.codex/auth.json`) **read-only**: fine while it is valid, but it never refreshes it, because a
refresh rotates the refresh token and would log `codex` out.

## Use

```bash
cd your-project
claude-gpt            # any `claude` arguments pass through: claude-gpt -p "…", claude-gpt --resume
```

Other commands: `claude-gpt status | restart | stop | models | ping [model] | logs`.
`ping` sends one request through the router without starting Claude Code — the quickest check.

## Model mapping ([`router.js`](router.js))

| In Claude Code (`/model`) | → Codex model | |
|---|---|---|
| Default / Opus | `gpt-6-astra` | frontier, heavy work |
| Fable slot | `gpt-6.1-terra` | balanced, 500k |
| Sonnet | `gpt-6.1-sol` | coding workhorse, 500k |
| Haiku (background tasks) | `gpt-6-luna` | fast and cheap |

`/model` lists them under their real names, and the header, status line and `/context` show the
real model (`gpt-6-astra with high effort`): the launcher points `ANTHROPIC_DEFAULT_*_MODEL` at the
Codex IDs. The effort you pick in Claude Code (low…max) reaches Codex as `reasoning.effort`.
Any other Codex model: `/model codex,<id>` — `claude-gpt models` lists what your plan offers.

- ⚠️ In `/model`, press **`s`** (this session only), not Enter: Enter saves the choice as the default
  in `~/.claude/settings.json`, which your normal `claude` shares.
- The context window is capped at 272k (`CODEX_GPT_CONTEXT`), the smallest among the mapped models,
  so Claude Code auto-compacts before the backend refuses the conversation.
- The $ cost Claude Code shows is cosmetic.

## How it is wired

- `codex-gpt` (the launcher) starts a private CCR on **port 3457** with
  `HOME=~/.codex-gpt/ccr-home`, so it never collides with another CCR you may run on the default
  `~/.claude-code-router` / port 3456. It restarts the router by itself when `config.template.json`,
  `router.js` or `codex.js` change.
- `config.json` is rendered from `config.template.json` with this folder's path (git-ignored).
- `claude` itself runs with your real `HOME` (your login, settings and sessions untouched) and
  `ANTHROPIC_BASE_URL=http://127.0.0.1:3457`.
- `codex.js`, what the Codex backend needs and Claude Code sends:
  - chat → Responses API with `stream: true`, `store: false`, no `temperature`;
  - the OAuth headers of the Codex CLI (`Authorization`, `chatgpt-account-id`,
    `originator: codex_cli_rs`) and token refresh;
  - a per-conversation `prompt_cache_key`, so prompt caching actually hits;
  - SSE → chat chunks, including **parallel tool calls**, whose arguments arrive whole in
    `response.output_item.done` with no deltas, and usage;
  - Claude Code's **mid-conversation `system` messages** (cross-session messages, notifications)
    stay in place as `developer` messages — moved into `instructions`, the model would never notice
    they arrived;
  - the effort, which Claude Code sends in `output_config.effort` and CCR drops.
- `stripreasoning.js` + the `openai` provider in the config are an optional extra: `/model
  openai,gpt-5.5` goes to the paid API with `$OPENAI_API_KEY`.

## Uninstall

```bash
claude-gpt stop
rm -rf ~/.codex-gpt ~/.local/bin/claude-gpt   # and this folder
```

## ⚠️ Terms

OpenAI officially lets some third-party harnesses use a ChatGPT plan (OpenCode, Devin, Amp, Warp…),
but has no published terms for a proxy that presents itself as the Codex client. It works today;
it can stop working any day. Use at your own risk.
