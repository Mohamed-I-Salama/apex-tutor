// why: the artifact asks Claude through the claude.ai viewer, which a plain website does not
// have. This stands in for the viewer's `sample`, so the same page answers through Apex's own
// model, Qwen3.6-35B-A3B, which model_server.py serves from Modal CPUs.
(function () {
  if (window.claude) return;

  var ENDPOINT = "https://msalama42003--apex-model-model-serve.us-east.modal.run/v1/chat/completions";
  var SLOW_MS = 8000;
  var RETRY_MS = 5000;
  var MAX_START_MS = 240000;
  // why: Qwen's recommended settings for answering without a thinking phase, which would add a long silence on CPUs.
  var SETTINGS = {
    max_tokens: 1500,
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    presence_penalty: 1.5,
    chat_template_kwargs: { enable_thinking: false },
  };

  function failure(code, message, text) {
    var error = { code: code, message: message || code };
    if (text) error.text = text;
    return error;
  }

  function stopped(signal) {
    return Boolean(signal && signal.aborted);
  }

  function showNotice(text) {
    var bar = document.createElement("div");
    bar.setAttribute("role", "status");
    bar.style.cssText = [
      "position:fixed",
      "top:calc(12px + env(safe-area-inset-top, 0px))",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "width:max-content",
      "max-width:calc(100% - 32px)",
      "padding:10px 14px",
      "border-radius:10px",
      "background:#1d2430",
      "color:#fff",
      "font:600 14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      "box-shadow:0 6px 20px rgba(0,0,0,.3)",
      "text-align:center",
    ].join(";");
    bar.textContent = text;
    document.body.appendChild(bar);
    return bar;
  }

  function pause(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (stopped(signal)) {
        reject(failure("cancelled", "Stopped"));
        return;
      }
      var onAbort = function () {
        clearTimeout(timer);
        reject(failure("cancelled", "Stopped"));
      };
      var timer = setTimeout(function () {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function once(messages, opts, onFirstText) {
    var res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ model: "apex", stream: true, messages: messages }, SETTINGS)),
        signal: opts.signal,
      });
    } catch (err) {
      if (stopped(opts.signal)) throw failure("cancelled", "Stopped");
      return { retry: true };
    }
    // why: these come from Modal while the model's machine is still starting after a quiet spell.
    if (res.status === 502 || res.status === 503 || res.status === 504) return { retry: true };
    if (res.status === 429) throw failure("rate_limited", "Apex's model is busy.");
    if (!res.ok || !res.body) throw failure("upstream_error", "Apex's model answered " + res.status + ".");
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var pending = "";
    var text = "";
    var reason = null;
    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        var lines = pending.split("\n");
        pending = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.slice(0, 5) !== "data:") continue;
          var data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          var event;
          try {
            event = JSON.parse(data);
          } catch (err) {
            continue;
          }
          var choice = event.choices && event.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) reason = choice.finish_reason;
          var delta = choice.delta && choice.delta.content;
          if (typeof delta === "string" && delta) {
            if (!text) onFirstText();
            text += delta;
            if (opts.onText) opts.onText({ text: text, delta: delta });
          }
        }
      }
    } catch (err) {
      throw stopped(opts.signal)
        ? failure("cancelled", "Stopped", text)
        : failure("upstream_error", "The connection dropped.", text);
    }
    if (!text.trim()) throw failure("empty_completion", "No answer came back.");
    return { text: text, truncated: reason === "length" };
  }

  async function sample(input, opts) {
    opts = opts || {};
    var turns =
      typeof input === "string" ? [{ role: "user", content: input }] : Array.prototype.slice.call(input);
    // why: the page sends its instructions as the first turn; a chat model follows them best as the system message.
    var messages = turns.map(function (turn, i) {
      return { role: i === 0 && turns.length > 1 ? "system" : turn.role, content: String(turn.content) };
    });
    var bar = null;
    var slow = setTimeout(function () {
      bar = showNotice("Apex runs on its own model, so a first answer can take up to a minute to start.");
    }, SLOW_MS);
    var settle = function () {
      clearTimeout(slow);
      if (bar) bar.remove();
      bar = null;
    };
    var began = Date.now();
    try {
      for (;;) {
        if (stopped(opts.signal)) throw failure("cancelled", "Stopped");
        var out = await once(messages, opts, settle);
        if (!out.retry) return out;
        if (Date.now() - began > MAX_START_MS) {
          throw failure("upstream_error", "Apex's model didn't start in time.");
        }
        await pause(RETRY_MS, opts.signal);
      }
    } finally {
      settle();
    }
  }

  sample.limits = function () {
    // why: the model reads about 120 tokens a second on CPUs, so a smaller prompt keeps the wait for an answer short.
    return Promise.resolve({ maxPromptBytes: 24000, modelTiers: ["default"] });
  };

  window.claude = {
    use: function (name) {
      return Promise.resolve(name === "sample" ? sample : null);
    },
  };
})();
