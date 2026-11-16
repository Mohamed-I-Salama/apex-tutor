"""Apex's own model for the website: Qwen3.6-35B-A3B on Modal CPUs.

    modal deploy model_server.py

llama.cpp serves the model with an OpenAI-style chat API that the website calls directly.
The starter kit's ADR 0007 and docs/MODELS.md explain the choice of model and machine.

why: the image is built exactly as in the kit's model trial, so Modal can reuse the image it
already has, model included, instead of downloading it again.
"""

from __future__ import annotations

import glob
import os
import subprocess
import time
import urllib.request

import modal

LLAMA_TAG = "b11940"
REPO = "unsloth/Qwen3.6-35B-A3B-GGUF"
GGUF = "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
MMPROJ = "mmproj-F16.gguf"
CORES = 16
PORT = 8080

image = (
    modal.Image.from_registry("ubuntu:24.04", add_python="3.12")
    .apt_install("curl", "ca-certificates", "libgomp1")
    .run_commands(
        f"curl -fsSL -o /tmp/llama.tar.gz https://github.com/ggml-org/llama.cpp/releases/download/"
        f"{LLAMA_TAG}/llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz",
        "mkdir -p /opt/llama && tar -xzf /tmp/llama.tar.gz -C /opt/llama && rm /tmp/llama.tar.gz",
    )
    .run_commands(
        f"mkdir -p /models && curl -fsSL -o /models/model.gguf https://huggingface.co/{REPO}/resolve/main/{GGUF}",
        f"curl -fsSL -o /models/mmproj.gguf https://huggingface.co/{REPO}/resolve/main/{MMPROJ}",
        "ls -la /models",
    )
)

app = modal.App("apex-model")


# why: one container at most caps what a public page can spend, about $1 an hour, and it sleeps after 5 idle minutes.
@app.cls(image=image, cpu=CORES, memory=32768, max_containers=1, scaledown_window=300, timeout=60 * 60)
@modal.concurrent(max_inputs=16)
class Model:
    @modal.enter()
    def load(self) -> None:
        server = sorted(glob.glob("/opt/llama/**/llama-server", recursive=True))[0]
        env = dict(os.environ, LD_LIBRARY_PATH=os.path.dirname(server))
        # why: the page sends no pictures, so the vision projector stays unloaded; two slots answer two students at once.
        self.proc = subprocess.Popen(
            [server, "-m", "/models/model.gguf", "--host", "0.0.0.0", "--port", str(PORT),
             "-t", str(CORES), "-c", "24576", "-np", "2", "-n", "1500", "--jinja", "--reasoning-budget", "0"],
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
