"""Apex's own model for the website: Qwen3.6-35B-A3B on Modal CPUs.

    modal deploy model_server.py

llama.cpp serves the model with an OpenAI-style chat API that the website calls directly. The
model's own settings (sampling, thinking off) live here, so the website works with any model.

ADR 0007 in the starter kit explains running Apex's own open model on CPUs. On 2026-11-17 the model
was compared on these CPUs with Qwen3.8-Flash-Next (180B), gpt-oss-120b and Gemma 4 26B-A4B, using
the page's real requests:
- Qwen3.6: starts in 25 s, reads 113 tokens/s, writes 13.6 tokens/s; best on the PDF tasks.
- gpt-oss-120b: starts in 66 s, reads 60/s, writes 10/s, no pictures; no more accurate overall.
- Qwen3.8-Flash-Next: starts in 97 s, reads 35/s, writes 6/s; knows rules better, still errs.
- Gemma 4 26B-A4B: ignored Apex's length rules, writing 2,000 to 5,000 tokens per answer.
Qwen3.6 stayed; the upgrade is the newer llama.cpp and the page's instruction fixes.

why: the image is built with exactly the comparison's steps, so Modal reuses the image it already
has, model included, instead of downloading it again.
"""

from __future__ import annotations

import glob
import os
import subprocess
import time
import urllib.request

import modal

LLAMA_TAG = "b12470"
# why: this copy of the model includes its multi-token-prediction head, which drafts the next words.
REPO = "unsloth/Qwen3.6-35B-A3B-MTP-GGUF"
FILES = ["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", "mmproj-F16.gguf"]
CORES = 16
PORT = 8080
# why: one shared pool lets a student with a long PDF use most of it while a second student chats.
CONTEXT = 65536
SLOTS = 2
# why: a 30-question quiz is about 6,000 tokens; this stops a runaway answer at about ten minutes.
MAX_ANSWER = 8192
# why: bigger prompt batches let the CPUs reuse each expert's weights across more tokens.
BATCH = 2048
# why: a page picture costs about one token per 32x32 pixels; this keeps one picture near 30 s on CPUs.
IMAGE_TOKENS = 1024
# Qwen's recommended settings for answering without a thinking phase, which would add a long silence on CPUs.
SETTINGS = ["--temp", "0.7", "--top-p", "0.8", "--top-k", "20", "--min-p", "0", "--presence-penalty", "1.5",
            "--chat-template-kwargs", '{"enable_thinking": false}', "--reasoning-budget", "0"]
# why: drafting with the model's own prediction head (--spec-type draft-mtp) wrote 21% faster on a
# short answer but 10% slower on a quiz over a long PDF, the usual case here, so it stays off.
SPEEDUP: list[str] = []

image = modal.Image.from_registry("ubuntu:24.04", add_python="3.12").apt_install("curl", "ca-certificates", "libgomp1")
for _file in FILES:
    image = image.run_commands(
        f"mkdir -p /models && curl -fsSL --retry 5 -o /models/{_file} https://huggingface.co/{REPO}/resolve/main/{_file}"
    )
image = image.run_commands(
    f"curl -fsSL -o /tmp/llama.tar.gz https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz",
    "mkdir -p /opt/llama && tar -xzf /tmp/llama.tar.gz -C /opt/llama && rm /tmp/llama.tar.gz",
)

app = modal.App("apex-model")


# why: one container at most caps what a public page can spend, about $1 an hour, and it sleeps after 5 idle minutes.
# Pre-emption stays allowed: turning it off triples the price, and the page resumes an answer that gets cut.
@app.cls(image=image, cpu=CORES, memory=40960, max_containers=1, scaledown_window=300, timeout=60 * 60)
@modal.concurrent(max_inputs=16)
class Model:
    @modal.enter()
    def load(self) -> None:
        server = sorted(glob.glob("/opt/llama/**/llama-server", recursive=True))[0]
        env = dict(os.environ, LD_LIBRARY_PATH=os.path.dirname(server))
        # why: checkpoints every 512 tokens let a follow-up reuse the instructions, the PDF and the
        # conversation already read, instead of reading them again at about 120 tokens a second.
        self.proc = subprocess.Popen(
            [server, "-m", f"/models/{FILES[0]}", "--mmproj", f"/models/{FILES[1]}",
             "--host", "0.0.0.0", "--port", str(PORT), "-t", str(CORES),
             "-c", str(CONTEXT), "-np", str(SLOTS), "--kv-unified", "-n", str(MAX_ANSWER),
             "-b", str(BATCH), "-ub", str(BATCH),
             "--ctx-checkpoints", "16", "--checkpoint-min-step", "512", "--cache-ram", "4096",
             "--image-max-tokens", str(IMAGE_TOKENS), "--jinja"] + SETTINGS + SPEEDUP,
            env=env,
        )
        # why: llama-server opens its port before the model is in memory, so wait here until it can answer.
        started = time.time()
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as reply:
                    if reply.status == 200:
                        return
            except Exception:
                pass
            if self.proc.poll() is not None:
                raise RuntimeError("llama-server stopped while loading the model")
            if time.time() - started > 900:
                raise TimeoutError("llama-server was not ready within 15 minutes")
            time.sleep(0.5)

    @modal.web_server(PORT, startup_timeout=900)
    def serve(self) -> None:
        return None
