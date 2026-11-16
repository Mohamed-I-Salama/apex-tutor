// why: the artifact asks Claude through the claude.ai viewer, which a plain website does not
// have. This stands in for the viewer's `sample`, so the same page answers through a free,
// keyless AI service. Its free tier allows each person one answer every 45 seconds.
(function () {
  if (window.claude) return;

  var ENDPOINT = "https://text.pollinations.ai/openai";
  var MODEL = "openai";
  var MAX_WAIT_S = 60;
  // why: the service silently holds a streamed request until 45 s after the previous one began, which looked like a stuck "Thinking", so the page counts that gap down itself.
  var GAP_MS = 46000;
  var lastStart = 0;

  function failure(code, message, text) {
    var error = { code: code, message: message || code };
    if (text) error.text = text;
    return error;
  }

  function stopped(signal) {
    return Boolean(signal && signal.aborted);
  }

  function waitWithNotice(seconds, signal) {
    return new Promise(function (resolve, reject) {
      if (stopped(signal)) {
        reject(failure("cancelled", "Stopped"));
        return;
      }
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
      var left = seconds;
      var show = function () {
        bar.textContent =
          "Free AI: one answer every 45 seconds. Yours starts in " + left + " seconds.";
      };
      var finish = function () {
        clearInterval(timer);
        bar.remove();
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      var onAbort = function () {
        finish();
        reject(failure("cancelled", "Stopped"));
      };
      var timer = setInterval(function () {
        left -= 1;
        if (left > 0) {
          show();
          return;
        }
        finish();
        resolve();
      }, 1000);
      show();
      document.body.appendChild(bar);
      if (signal) signal.addEventListener("abort", onAbort);
    });
  }

  async function once(messages, opts) {
    var res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, stream: true, messages: messages }),
        signal: opts.signal,
      });
    } catch (err) {
      throw stopped(opts.signal)
        ? failure("cancelled", "Stopped")
        : failure("upstream_error", "Couldn't reach the AI service.");
    }
    if (res.status === 402 || res.status === 429) {
      var note = await res.text().catch(function () {
        return "";
      });
      var after = /retry after (\d+)/i.exec(note);
      return { wait: after ? Number(after[1]) + 1 : 46 };
    }
    if (!res.ok || !res.body) {
      throw failure("upstream_error", "The AI service answered " + res.status + ".");
    }
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
    var waited = 0;
    for (;;) {
      if (stopped(opts.signal)) throw failure("cancelled", "Stopped");
      var gap = Math.ceil((lastStart + GAP_MS - Date.now()) / 1000);
      if (gap > 0) await waitWithNotice(gap, opts.signal);
      lastStart = Date.now();
      var out = await once(messages, opts);
      if (!out.wait) return out;
      if (waited + out.wait > MAX_WAIT_S) throw failure("rate_limited", "Free limit reached.");
      waited += out.wait;
      await waitWithNotice(out.wait, opts.signal);
    }
  }

  sample.limits = function () {
    return Promise.resolve({ maxPromptBytes: 48000, modelTiers: ["default"] });
  };

  window.claude = {
    use: function (name) {
      return Promise.resolve(name === "sample" ? sample : null);
    },
  };
})();
