// CCR custom transformer: sterge parametrii de "thinking/reasoning" pe care
// endpoint-ul OpenAI /v1/chat/completions NU ii accepta la modelele gpt-5.x.
//
// De ce: Claude Code (extended thinking, "xhigh effort") trimite `thinking` ->
// CCR il converteste in obiectul `reasoning` {effort, enabled} (format Responses API)
// -> /v1/chat/completions raspunde 400 "Unknown parameter: 'reasoning'".
// Stergem reasoning/thinking; gpt-5.x ramane model de reasoning si gandeste implicit.
class StripReasoning {
  static TransformerName = "stripreasoning";

  constructor(options = {}) {
    this.name = "stripreasoning"; // CCR cere proprietatea `name` pe instanta
    this.options = options || {};
  }

  async transformRequestIn(request) {
    const strip = (o) => {
      if (!o || typeof o !== "object") return;
      delete o.reasoning;
      delete o.thinking;
      delete o.enable_thinking;
    };
    strip(request);
    if (request && typeof request === "object") strip(request.body);
    return request;
  }

  async transformResponseOut(response) {
    return response;
  }
}

module.exports = StripReasoning;
