// CCR custom router: modelul cerut de Claude Code -> provider,model.
// codex-gpt setează ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL pe ID-urile Codex reale, deci de obicei
// sosește direct "gpt-6-astra" etc. (și asta se vede în header / statusline). Rămâne și maparea după
// nume, pentru cereri care vin cu ID-uri claude-* (ex. `codex-gpt ping claude-sonnet-4-5`).
//   Opus -> gpt-6-astra · Sonnet -> gpt-6.1-sol · Haiku -> gpt-6-luna
// "provider,model" explicit (ex. /model openai,gpt-5.5) trece neatins.
module.exports = async function router(req) {
  const model = String((req && req.body && req.body.model) || "").replace(/\[.*\]$/, "");
  if (model.includes(",")) return model;
  if (/^gpt-/i.test(model)) return `codex,${model}`;
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "codex,gpt-6-luna";
  if (m.includes("sonnet")) return "codex,gpt-6.1-sol";
  return "codex,gpt-6-astra";
};
