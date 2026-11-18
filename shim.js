// why: the artifact asks Claude through the claude.ai viewer, which a plain website does not
// have. This stands in for the viewer's `sample`, so the same page answers through Apex's own
// model, Qwen3.6-35B-A3B, which model_server.py serves from Modal CPUs.
//
// Beyond the viewer's API it offers what a slow model that keeps what it has read needs:
// limits().prefixCache, sample.warm() to read ahead, sample.keepAlive(), and opts.onProgress.
(function () {
  if (window.claude) return;

  var BASE = "https://msalama42003--apex-model-model-serve.us-east.modal.run";
  var ENDPOINT = BASE + "/v1/chat/completions";
  var RETRY_MS = 5000;
  var MAX_START_MS = 240000;
  var RESUMES = 2;
  // why: an awake server answers within a second; no answer by then means its machine is starting,
  // which takes about a minute after 5 idle minutes.
  var WAKE_MS = 3000;
  // why: 8,000 tokens fits a 30-question quiz. The model's own settings (sampling, thinking off) are
  // set on the server in model_server.py, so a model change doesn't need a website change.
  var SETTINGS = { max_tokens: 8000 };

  function failure(code, message, text) {
    var error = { code: code, message: message || code };
    if (text) error.text = text;
    return error;
  }

  function stopped(signal) {
    return Boolean(signal && signal.aborted);
  }

  function noop() {}

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

  // The page sends its instructions as the first turn; a chat model follows them best as the system message.
  function toMessages(input) {
    var turns = typeof input === "string" ? [{ role: "user", content: input }] : Array.prototype.slice.call(input);
    return turns.map(function (turn, i) {
      return { role: i === 0 && turns.length > 1 ? "system" : turn.role, content: String(turn.content) };
    });
  }

  // why: the server reads JPEG and PNG, not WebP; and a phone photo is far bigger than the model uses.
  function toJpeg(blob) {
    return createImageBitmap(blob).then(function (bmp) {
      var scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      if (bmp.close) bmp.close();
      return canvas.toDataURL("image/jpeg", 0.85);
    });
  }

  // One request. Streams text after `prefix`, reports progress, and says whether the answer finished,
  // was cut off, or the model's machine isn't ready yet.
  async function once(body, opts, report, prefix) {
    var waking = setTimeout(function () {
      report({ phase: "waking" });
    }, WAKE_MS);
    var res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      clearTimeout(waking);
      if (stopped(opts.signal)) throw failure("cancelled", "Stopped", prefix);
      return { retry: true };
    }
    clearTimeout(waking);
    // why: these come from Modal while the model's machine is still starting after a quiet spell.
    if (res.status === 502 || res.status === 503 || res.status === 504) return { retry: true };
    if (res.status === 429) throw failure("rate_limited", "Apex's model is busy.", prefix);
    if (res.status === 400) {
      var said = "";
      try {
        said = await res.text();
      } catch (err) {
        said = "";
      }
      if (/context|exceed|too long|n_ctx/i.test(said)) throw failure("prompt_too_large", "Too much text for one question.", prefix);
      throw failure("invalid_request", "Apex's model couldn't read this request.", prefix);
    }
    if (!res.ok || !res.body) throw failure("upstream_error", "Apex's model answered " + res.status + ".", prefix);
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
          if (event.prompt_progress) {
            var p = event.prompt_progress;
            report({ phase: "reading", total: p.total, cache: p.cache, processed: p.processed });
          }
          var choice = event.choices && event.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) reason = choice.finish_reason;
          var delta = choice.delta && choice.delta.content;
          if (typeof delta === "string" && delta) {
            text += delta;
            if (opts.onText) opts.onText({ text: prefix + text, delta: delta });
          }
        }
      }
    } catch (err) {
      if (stopped(opts.signal)) throw failure("cancelled", "Stopped", prefix + text);
      return { cut: true, text: text };
    }
    // why: when Modal moves the machine mid-answer, the stream just ends, with no finish reason.
    if (!reason) return { cut: true, text: text };
    return { text: text, reason: reason };
  }

  // Keep asking until the model's machine is up; carry on from the cut when an answer is cut off.
  async function run(messages, opts, extra) {
    var report = opts.onProgress || noop;
    var base = Object.assign({ model: "apex", stream: true, return_progress: true, messages: messages }, SETTINGS, extra);
    var began = Date.now();
    var done = "";
    var resumes = 0;
    for (;;) {
      if (stopped(opts.signal)) throw failure("cancelled", "Stopped", done);
      // why: the server continues a final assistant message instead of starting a new answer.
      var body = done ? Object.assign({}, base, { messages: messages.concat([{ role: "assistant", content: done }]) }) : base;
      var out = await once(body, opts, report, done);
      if (out.retry) {
        if (Date.now() - began > MAX_START_MS) throw failure("upstream_error", "Apex's model didn't start in time.", done);
        await pause(RETRY_MS, opts.signal);
        continue;
      }
      done += out.text;
      if (out.cut) {
        if (resumes >= RESUMES) throw failure("upstream_error", "The connection dropped.", done);
        resumes += 1;
        began = Date.now();
        report({ phase: "resuming" });
        continue;
      }
      return { text: done, reason: out.reason };
    }
  }

  async function sample(input, opts) {
    opts = opts || {};
    var messages = toMessages(input);
    if (opts.images && opts.images.length) {
      var urls = await Promise.all(Array.prototype.map.call(opts.images, toJpeg));
      var last = messages[messages.length - 1];
      last.content = urls
        .map(function (url) {
          return { type: "image_url", image_url: { url: url } };
        })
        .concat([{ type: "text", text: last.content }]);
    }
    var out = await run(messages, opts, {});
    if (!out.text.trim()) throw failure("empty_completion", "No answer came back.");
    return { text: out.text, truncated: out.reason === "length" };
  }

  // Have the model read these turns now, so the question that follows only reads what is new.
  sample.warm = async function (input, opts) {
    opts = opts || {};
    await run(toMessages(input), opts, { max_tokens: 1 });
  };

  // A light request that stops the model's machine going to sleep while someone is using the page.
  sample.keepAlive = function () {
    return fetch(BASE + "/health").then(noop, noop);
  };

  sample.limits = function () {
    return Promise.resolve({
      // why: about 27,000 tokens, which leaves room for a long quiz in the model's 64k context.
      maxPromptBytes: 110000,
      modelTiers: ["default"],
      images: { maxCount: 2, maxInputBytes: 20 * 1024 * 1024 },
      prefixCache: true,
      // why: this site may download a text recogniser for scanned PDFs; the claude.ai viewer can't.
      ocr: true,
    });
  };

  window.claude = {
    use: function (name) {
      return Promise.resolve(name === "sample" ? sample : null);
    },
  };
})();
