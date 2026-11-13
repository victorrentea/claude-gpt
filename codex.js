// CCR custom transformer: Claude Code -> backend-ul Codex al abonamentului ChatGPT.
//
// Calea: Claude Code (Anthropic /v1/messages) -> CCR (format unificat OpenAI chat) -> ACEST
// transformer -> POST https://chatgpt.com/backend-api/codex/responses (Responses API, ca `codex`).
// Consumul merge pe cota abonamentului ChatGPT (Plus/Pro), NU pe credit API.
//
// Cerințele backend-ului (măsurate 2026-11-11): stream=true și store=false obligatorii,
// `temperature` respins, `instructions` opțional, modele doar din lista Codex (gpt-6-astra, ...).
//
// Auth: auth.json în formatul `codex login` (tokens.access_token/refresh_token/account_id).
// Implicit ~/.codex-gpt/auth.json = o sesiune SEPARATĂ (`codex-gpt login`), ca refresh-ul de aici
// să nu invalideze token-ul lui `codex`. Pe ~/.codex/auth.json NU facem niciodată refresh.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// routerul rulează cu HOME schimbat (izolare de claude-local); HOME-ul real vine separat
const REAL_HOME = process.env.CODEX_GPT_REAL_HOME || os.homedir();
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // clientul OAuth al Codex CLI
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return (p.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

class CodexTransformer {
  static TransformerName = "codex";

  constructor(options = {}) {
    this.name = "codex"; // CCR cere `name` pe instanță
    this.options = options || {};
    this.authFile = (this.options.authFile || "~/.codex-gpt/auth.json").replace(/^~/, REAL_HOME);
    this.mainCodexAuth = path.join(REAL_HOME, ".codex", "auth.json");
    this.defaultEffort = this.options.defaultEffort || "medium";
    this.refreshing = null;
  }

  // ---------- auth ----------
  readAuth() {
    // fără sesiune proprie încă: împrumutăm read-only token-ul lui `codex` (fără refresh)
    // (decis la fiecare cerere: după `codex-gpt login` trece singur pe sesiunea proprie)
    const file = fs.existsSync(this.authFile) ? this.authFile : this.mainCodexAuth;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j.tokens || !j.tokens.access_token) {
      throw new Error(`codex-gpt: ${file} nu are tokens.access_token — rulează: codex-gpt login`);
    }
    j.__file = file;
    return j;
  }

  async refresh(auth) {
    const file = auth.__file;
    delete auth.__file;
    if (path.resolve(file) === path.resolve(this.mainCodexAuth)) {
      throw new Error("codex-gpt: token-ul din ~/.codex a expirat; nu-l reîmprospătez de aici (l-ar strica pe codex). Rulează: codex-gpt login");
    }
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.tokens.refresh_token,
        scope: "openid profile email",
      }),
    });
    if (!res.ok) {
      throw new Error(`codex-gpt: refresh eșuat (${res.status}) — rulează: codex-gpt login. ${(await res.text()).slice(0, 200)}`);
    }
    const t = await res.json();
    auth.tokens.access_token = t.access_token || auth.tokens.access_token;
    auth.tokens.refresh_token = t.refresh_token || auth.tokens.refresh_token;
    auth.tokens.id_token = t.id_token || auth.tokens.id_token;
    auth.last_refresh = new Date().toISOString();
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return auth;
  }

  async tokens() {
    let auth = this.readAuth();
    if (jwtExp(auth.tokens.access_token) - Date.now() < 5 * 60 * 1000) {
      // un singur refresh simultan; cererile paralele îl așteaptă pe același
      this.refreshing = this.refreshing || this.refresh(auth).finally(() => (this.refreshing = null));
      auth = await this.refreshing;
    }
    return auth.tokens;
  }

  // ---------- cerere: chat (unificat CCR) -> Responses ----------
  textOf(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((c) => (typeof c === "string" ? c : c && c.text ? c.text : "")).filter(Boolean).join("\n");
  }

  contentParts(content, role) {
    const kind = role === "assistant" ? "output_text" : "input_text";
    if (typeof content === "string") return content ? [{ type: kind, text: content }] : [];
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const c of content) {
      if (!c) continue;
      if (typeof c === "string") out.push({ type: kind, text: c });
      else if (c.type === "text" && c.text) out.push({ type: kind, text: c.text });
      else if (c.type === "image_url" && role !== "assistant" && c.image_url?.url) {
        out.push({ type: "input_image", image_url: c.image_url.url });
      }
    }
    return out;
  }

  async transformRequestIn(body, provider, ctx) {
    const wantStream = body.stream === true;
    if (ctx && ctx.req) ctx.req.__codexWantStream = wantStream;

    const instructions = [];
    const input = [];
    for (const m of body.messages || []) {
      if (m.role === "system") {
        // Doar system-ul din capul conversației devine `instructions`. Claude Code trimite și mesaje
        // system la mijloc (mesaje cross-session, notificări venite în timpul lucrului): acelea rămân
        // la locul lor, ca `developer`, altfel modelul nu vede că au sosit DUPĂ ultimul pas.
        const t = this.textOf(m.content);
        if (!t) continue;
        if (input.length === 0) instructions.push(t);
        else input.push({ type: "message", role: "developer", content: [{ type: "input_text", text: t }] });
      } else if (m.role === "tool") {
        input.push({ type: "function_call_output", call_id: m.tool_call_id, output: this.textOf(m.content) || "" });
      } else if (m.role === "assistant") {
        const parts = this.contentParts(m.content, "assistant");
        if (parts.length) input.push({ type: "message", role: "assistant", content: parts });
        for (const tc of m.tool_calls || []) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments || "{}",
          });
        }
      } else {
        const parts = this.contentParts(m.content, "user");
        if (parts.length) input.push({ type: "message", role: "user", content: parts });
      }
    }

    const out = {
      model: body.model,
      instructions: instructions.join("\n\n") || undefined,
      input,
      stream: true,
      store: false,
      parallel_tool_calls: true,
    };

    if (Array.isArray(body.tools) && body.tools.length) {
      out.tools = body.tools
        .filter((t) => t.type === "function" && t.function?.name)
        .map((t) => ({
          type: "function",
          name: t.function.name,
          description: t.function.description || "",
          parameters: t.function.parameters || { type: "object", properties: {} },
        }));
      const tc = body.tool_choice;
      if (tc === "auto" || tc === "none" || tc === "required") out.tool_choice = tc;
      else if (tc && tc.function?.name) out.tool_choice = { type: "function", name: tc.function.name };
      else out.tool_choice = "auto";
    }

    // Claude Code trimite effort-ul în `output_config.effort` (Anthropic); CCR îl pierde la conversie,
    // așa că îl luăm din cererea originală. Nivelurile coincid cu Codex: low..max.
    const orig = ctx?.req?.body || {};
    let effort = orig.output_config?.effort || body.reasoning?.effort || this.defaultEffort;
    if (!EFFORTS.includes(effort)) effort = this.defaultEffort;
    out.reasoning = { effort, summary: "auto" };

    // ieșire structurată (ex. titlul sesiunii cerut ca JSON schema)
    const fmt = orig.output_config?.format;
    if (fmt && fmt.type === "json_schema" && fmt.schema) {
      out.text = { format: { type: "json_schema", name: "output", schema: fmt.schema, strict: false } };
    }

    // cache de prompt pe partea OpenAI: aceeași cheie pentru toată conversația
    const seed = (ctx?.req?.body?.metadata?.user_id) || JSON.stringify(input.slice(0, 1)) + (out.instructions || "").slice(0, 2000);
    out.prompt_cache_key = crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 32);

    if (ctx && ctx.req) ctx.req.__codexAsked = { model: out.model, effort };
    const t = await this.tokens();
    return {
      body: out,
      config: {
        headers: {
          Authorization: `Bearer ${t.access_token}`,
          "chatgpt-account-id": t.account_id,
          originator: "codex_cli_rs",
          "OpenAI-Beta": "responses=experimental",
          Accept: "text/event-stream",
          session_id: out.prompt_cache_key,
        },
      },
    };
  }

  // ---------- răspuns: SSE Responses -> chunk-uri chat.completion ----------
  async transformResponseOut(response, ctx) {
    const ct = response.headers.get("Content-Type") || "";
    // backend-ul Codex răspunde SSE fără Content-Type; JSON vine doar la erori
    if (ct.includes("application/json") || !response.body) return response;
    const wantStream = ctx?.req?.__codexWantStream !== false;

    const chunks = this.convertStream(response.body, ctx?.req?.__codexAsked);
    if (wantStream) {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
          } catch (e) {
            controller.error(e);
            return;
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: response.status,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    // cerere ne-stream: adunăm totul într-un singur chat.completion
    let text = "", model, usage, finish = "stop", id;
    const calls = [];
    for await (const c of chunks) {
      id = id || c.id;
      model = c.model || model;
      if (c.usage) usage = c.usage;
      const ch = c.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      if (ch.delta?.content) text += ch.delta.content;
      for (const tc of ch.delta?.tool_calls || []) {
        if (!calls[tc.index]) calls[tc.index] = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
        if (tc.function?.arguments) calls[tc.index].function.arguments += tc.function.arguments;
      }
    }
    const tool_calls = calls.filter(Boolean);
    const json = {
      id: id || "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: finish }],
      usage,
    };
    return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  async *convertStream(body, asked) {
    const dec = new TextDecoder();
    const reader = body.getReader();
    let buf = "";
    let model;
    let toolIndex = -1;
    const toolIdx = new Map(); // item_id -> index
    const argsStreamed = new Set(); // item_id-uri ale căror argumente au plecat deja
    let sawTool = false;
    const base = () => ({ id: "chatcmpl-codex", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model });
    const chunk = (delta, finish_reason = null) => ({ ...base(), choices: [{ index: 0, delta, finish_reason }] });

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.response?.model) model = ev.response.model;

        switch (ev.type) {
          case "response.output_text.delta":
            if (ev.delta) yield chunk({ role: "assistant", content: ev.delta });
            break;
          case "response.reasoning_summary_text.delta":
            if (ev.delta) yield chunk({ thinking: { content: ev.delta } });
            break;
          case "response.reasoning_summary_part.done":
            yield chunk({ thinking: { content: "\n\n" } });
            break;
          case "response.output_item.added":
            if (ev.item?.type === "function_call") {
              sawTool = true;
              toolIndex += 1;
              toolIdx.set(ev.item.id, toolIndex);
              yield chunk({
                role: "assistant",
                tool_calls: [{ index: toolIndex, id: ev.item.call_id, type: "function", function: { name: ev.item.name, arguments: "" } }],
              });
            }
            break;
          case "response.function_call_arguments.delta": {
            const idx = toolIdx.has(ev.item_id) ? toolIdx.get(ev.item_id) : toolIndex;
            if (ev.delta) {
              argsStreamed.add(ev.item_id);
              yield chunk({ tool_calls: [{ index: idx, function: { arguments: ev.delta } }] });
            }
            break;
          }
          case "response.output_item.done":
            // la apeluri paralele backend-ul nu trimite delta-uri: argumentele vin întregi aici
            if (ev.item?.type === "function_call" && !argsStreamed.has(ev.item.id) && toolIdx.has(ev.item.id)) {
              argsStreamed.add(ev.item.id);
              yield chunk({ tool_calls: [{ index: toolIdx.get(ev.item.id), function: { arguments: ev.item.arguments || "{}" } }] });
            }
            break;
          case "response.completed":
          case "response.incomplete": {
            const u = ev.response?.usage || {};
            // o linie per cerere în ~/.codex-gpt/router.log: ce s-a cerut vs ce a servit OpenAI
            console.error(`[codex] ${new Date().toISOString()} asked=${asked?.model} effort=${asked?.effort} served=${ev.response?.model} in=${u.input_tokens || 0} cached=${u.input_tokens_details?.cached_tokens || 0} out=${u.output_tokens || 0}`);
            const finish = sawTool ? "tool_calls" : ev.type === "response.incomplete" ? "length" : "stop";
            yield {
              ...chunk({}, finish),
              usage: {
                prompt_tokens: u.input_tokens || 0,
                completion_tokens: u.output_tokens || 0,
                total_tokens: u.total_tokens || 0,
                prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens || 0 },
              },
            };
            return;
          }
          case "response.failed":
          case "error": {
            const msg = ev.response?.error?.message || ev.error?.message || ev.message || "eroare necunoscută";
            yield chunk({ role: "assistant", content: `\n[codex-gpt] backend-ul Codex a răspuns cu eroare: ${msg}` }, "stop");
            return;
          }
        }
      }
    }
  }
}

module.exports = CodexTransformer;
