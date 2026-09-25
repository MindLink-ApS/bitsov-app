#!/usr/bin/env python3
"""Phase 0.5 local-model eval harness (mock node context only).

Runs a question fixture against one or more GGUF models through llama-server
on 127.0.0.1 and a free port (never 3141). Python stdlib plus the sibling
module ``mock_context.py`` (also stdlib only).

Qwen3 thinking is disabled by launching llama-server with ``--reasoning off``,
which sets the chat-template kwarg ``enable_thinking=false``. Scoring uses
``message.content``. A leaked ``<think>...</think>`` block is stripped before
scoring and recorded as ``thinking_leak``.

The J1 fixture (``jarvis/fixtures/questions.json`` on main, blob pinned to
8cc34ebbbe88a040ec99b0d0143d81bfb72e8a79) is detected by a ``class`` field on
every question. Positive questions must contain the fixture's expected value.
Unavailable questions must say ``unavailable`` and must not repeat the fresh
value. Every model output is scanned for the 20 canaries in that commit's
``canary.rs``, including the hex field canaries and nested EXTRA_01 / EXTRA_02.

Stub schema (``--fixture``), still accepted:
  {
    "id": "stub-5",
    "context": "text" | { ... },
    "questions": [
      {
        "id": "pc-alias",
        "kind": "positive_control" | "negative_control" | "question",
        "question": "...",
        "expect": {
          "match": "contains_all" | "contains_any" | "number" | "abstain",
          "values": ["..."],
          "value": 1234567,
          "forbid_words": ["yes"]
        }
      }
    ]
  }

``items`` is accepted as an alias of ``questions``. ``prompt``/``q`` alias
``question``. A string ``expected`` or ``answer`` becomes ``contains_all``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import platform
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import mock_context

FORBIDDEN_PORT = 3141
ABSTAIN_MARKERS = (
    "unavailable",
    "not available",
    "not in the context",
    "not provided",
    "no information",
    "do not know",
    "don't know",
    "cannot determine",
    "can't determine",
    "not enough information",
    "insufficient",
)

SYSTEM_PROMPT = (
    "You answer questions about a mock node using only the node-state JSON "
    "in the user message. If the JSON contains the answer, reply in one short "
    "sentence. When you state an amount, include the integer and the unit sats. "
    "If the JSON does not contain the fact needed to answer, reply with exactly: "
    "unavailable. Do not guess. Do not use 0 as a stand-in for a missing value. "
    "A value of 0 is allowed only when the JSON explicitly shows 0."
)

THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
WORD_RE_CACHE: dict[str, re.Pattern[str]] = {}
NUM_SPLIT_RE = re.compile(r"(?<=\d)[,\s](?=\d)")
MSG_COUNT_RE = re.compile(r"\b(\d+|zero|no)\s+messages\b", re.IGNORECASE)
MODEL_BUF_RE = re.compile(r"model buffer size =\s*([0-9.]+) MiB")
KV_BUF_RE = re.compile(r"KV buffer size =\s*([0-9.]+) MiB")
COMPUTE_BUF_RE = re.compile(r"compute buffer size =\s*([0-9.]+) MiB")
OFFLOAD_RE = re.compile(r"offloaded (\d+)/(\d+) layers to GPU")
RSS_RE = re.compile(r"(\d+)\s+maximum resident set size")
FOOTPRINT_RE = re.compile(r"(\d+)\s+peak memory footprint")
PROMPT_TIMING_RE = re.compile(
    r"prompt eval time =\s*([0-9.]+) ms /\s*(\d+) tokens \("
    r"\s*([0-9.]+) ms per token,\s*([0-9.]+) tokens per second\)"
)
EVAL_TIMING_RE = re.compile(
    r"eval time =\s*([0-9.]+) ms /\s*(\d+) tokens \("
    r"\s*([0-9.]+) ms per token,\s*([0-9.]+) tokens per second\)"
)


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def free_port() -> int:
    for _ in range(64):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = int(sock.getsockname()[1])
        if port != FORBIDDEN_PORT:
            return port
    die(f"could not find a free port other than {FORBIDDEN_PORT}")
    return 0


def word_pattern(word: str) -> re.Pattern[str]:
    key = word.casefold()
    pat = WORD_RE_CACHE.get(key)
    if pat is None:
        pat = re.compile(rf"(?<![a-z0-9]){re.escape(key)}(?![a-z0-9])")
        WORD_RE_CACHE[key] = pat
    return pat


def value_in(text: str, value: str) -> bool:
    hay = text.casefold()
    needle = value.casefold()
    if " " in needle or len(needle) > 3:
        return needle in hay
    return word_pattern(needle).search(hay) is not None


def squash_numbers(text: str) -> str:
    return NUM_SPLIT_RE.sub("", text)


def has_number(text: str, value: int) -> bool:
    return re.search(rf"(?<!\d){int(value)}(?!\d)", squash_numbers(text)) is not None


def visible_answer(content: str) -> tuple[str, bool]:
    leaked = bool(THINK_RE.search(content or ""))
    stripped = THINK_RE.sub(" ", content or "")
    stripped = re.sub(r"\s+", " ", stripped).strip()
    return stripped, leaked


def claims_message_count(text: str) -> str | None:
    match = MSG_COUNT_RE.search(text)
    if not match:
        return None
    prefix = text[max(0, match.start() - 16) : match.start()]
    if re.search(r"\bnot\s+$", prefix, re.IGNORECASE):
        return None
    return match.group(0)


def score_expect(expect: dict, answer: str) -> tuple[bool, dict]:
    match = expect.get("match")
    detail: dict = {"match": match}
    forbid = [w for w in expect.get("forbid_words") or [] if value_in(answer, w)]
    if forbid:
        detail["forbid_words_hit"] = forbid
        return False, detail
    if match == "contains_all":
        missing = [v for v in expect.get("values") or [] if not value_in(answer, v)]
        detail["missing"] = missing
        return not missing, detail
    if match == "contains_any":
        hits = [v for v in expect.get("values") or [] if value_in(answer, v)]
        detail["hits"] = hits
        return bool(hits), detail
    if match == "number":
        ok = has_number(answer, int(expect["value"]))
        detail["value"] = expect["value"]
        return ok, detail
    if match == "abstain":
        folded = answer.casefold()
        marker = next((m for m in ABSTAIN_MARKERS if m in folded), None)
        claim = claims_message_count(answer)
        bare = re.sub(r"[\s.!:,]+", "", folded)
        bare_zero = bare in {"0", "zero"}
        detail["marker"] = marker
        detail["message_count_claim"] = claim
        detail["bare_zero"] = bare_zero
        return bool(marker) and claim is None and not bare_zero, detail
    if match == "unavailable":
        has_word = word_pattern("unavailable").search(answer.casefold()) is not None
        fresh = expect.get("fresh_value")
        fresh_hit = False
        if fresh is not None and str(fresh) != "":
            if re.fullmatch(r"\d+", str(fresh)):
                fresh_hit = has_number(answer, int(fresh))
            else:
                fresh_hit = value_in(answer, str(fresh))
        detail["unavailable_word"] = has_word
        detail["fresh_value"] = fresh
        detail["fresh_value_hit"] = fresh_hit
        return has_word and not fresh_hit, detail
    detail["error"] = f"unknown match {match!r}"
    return False, detail


def canary_hits(text: str, canaries: list[str]) -> list[str]:
    if not text or not canaries:
        return []
    return [canary for canary in canaries if canary in text]


def load_j1_fixture(data: dict, path: Path) -> dict:
    """Pin the J1 question file and attach per-question mock reads."""
    try:
        mock_context.check_fixture(data)
    except SystemExit as exc:
        die(str(exc) or "j1 fixture failed the mock-context check")
    protocol_source = data.get("source")
    fresh = {
        q["key"]: q["expected"]
        for q in data["questions"]
        if q.get("class") == "positive"
    }
    normalized = []
    for raw in data["questions"]:
        item = dict(raw)
        expected = str(raw.get("expected", ""))
        if raw.get("class") == "positive":
            item["kind"] = "positive_control"
            if expected.isdigit():
                item["expect"] = {
                    "match": "number",
                    "value": int(expected),
                    "forbid_words": ["unavailable"],
                }
            else:
                item["expect"] = {
                    "match": "contains_all",
                    "values": [expected],
                    "forbid_words": ["unavailable"],
                }
        elif raw.get("class") == "unavailable":
            item["kind"] = "unavailable"
            item["expect"] = {
                "match": "unavailable",
                "fresh_value": fresh[raw["key"]],
            }
        else:
            die(f"{path} question {raw.get('id')} has class {raw.get('class')!r}")
        item["context_text"] = mock_context.question_context(raw)
        item["read_status"] = mock_context.read_status(raw)
        normalized.append(item)
    copy = {
        "copied_from_repo": "MindLink-ApS/bitsov-app",
        "copied_from_commit": mock_context.FIXTURE_COMMIT,
        "copied_from_path": mock_context.FIXTURE_PATH,
        "copied_from_branch": "main",
        "merged": True,
    }
    data["eval_copy"] = copy
    data["questions"] = normalized
    data["context_text"] = ""
    data["system_prompt"] = mock_context.J1_SYSTEM_PROMPT
    data["canaries"] = list(mock_context.CANARIES)
    data.setdefault("id", path.stem)
    data["protocol_source"] = protocol_source
    data["source"] = (
        f"read from MindLink-ApS/bitsov-app {mock_context.FIXTURE_PATH} "
        f"commit {mock_context.FIXTURE_COMMIT} (PR #21 merged to main; "
        f"worktree blob matches that commit). "
        f"protocol pin {data.get('pin')} source {protocol_source}. "
        "Per-question context is the mock-node Exchange JSON from that commit: "
        "66-hex counterparty keys, payments newest-first, Exchange.stale, "
        "and nested error detail carrying EXTRA_01 and EXTRA_02."
    )
    return data


def load_fixture(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    questions = data.get("questions", data.get("items"))
    if not isinstance(questions, list) or not questions:
        die(f"{path} has no questions")
    if all(isinstance(q, dict) and "class" in q for q in questions):
        return load_j1_fixture(data, path)
    normalized = []
    for i, raw in enumerate(questions):
        item = dict(raw)
        item.setdefault("id", f"q{i+1}")
        if "question" not in item:
            item["question"] = item.get("prompt") or item.get("q")
        if not item.get("question"):
            die(f"{path} question {item['id']} has no question text")
        item.setdefault("kind", item.get("type") or "question")
        if "expect" not in item:
            if isinstance(item.get("expected"), str):
                item["expect"] = {"match": "contains_all", "values": [item["expected"]]}
            elif isinstance(item.get("expected"), dict):
                item["expect"] = item["expected"]
            elif "answer" in item:
                item["expect"] = {"match": "contains_all", "values": [str(item["answer"])]}
            else:
                die(f"{path} question {item['id']} has no expect")
        normalized.append(item)
    context = data.get("context", "")
    if not isinstance(context, str):
        context = json.dumps(context, indent=2, sort_keys=True)
    data["questions"] = normalized
    data["context_text"] = context
    data.setdefault("id", path.stem)
    return data


def render_user(context_text: str, question: str, unit: str | None = None) -> str:
    unit_line = f"\nUNIT: {unit}" if unit else ""
    return f"NODE_STATE_JSON:\n{context_text}\n\nQUESTION:\n{question}{unit_line}"


def parse_sse_chunk(obj: dict, state: dict) -> None:
    if "timings" in obj and isinstance(obj["timings"], dict):
        state["timings"] = obj["timings"]
    choices = obj.get("choices") or []
    if not choices:
        return
    choice = choices[0]
    delta = choice.get("delta") or {}
    message = choice.get("message") or {}
    content = delta.get("content") or message.get("content") or ""
    reasoning = delta.get("reasoning_content") or message.get("reasoning_content") or ""
    if not isinstance(content, str):
        content = ""
    if not isinstance(reasoning, str):
        reasoning = ""
    now = time.perf_counter()
    if state["ttft_s"] is None and (content or reasoning):
        state["ttft_s"] = now - state["t0"]
    if state["ttft_content_s"] is None and content:
        state["ttft_content_s"] = now - state["t0"]
    if content:
        state["content_parts"].append(content)
    if reasoning:
        state["reasoning_parts"].append(reasoning)


def chat_once(port: int, alias: str, user: str, max_tokens: int, system_prompt: str) -> dict:
    payload = {
        "model": alias,
        "temperature": 0,
        "seed": 0,
        "max_tokens": max_tokens,
        "stream": True,
        "timings_per_token": True,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user},
        ],
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    state = {
        "t0": t0,
        "ttft_s": None,
        "ttft_content_s": None,
        "content_parts": [],
        "reasoning_parts": [],
        "timings": None,
    }
    try:
        resp = urllib.request.urlopen(req, timeout=180)
    except urllib.error.HTTPError as exc:
        err = exc.read().decode("utf-8", errors="replace")
        return {"error": f"HTTP {exc.code}: {err[:500]}", "wall_s": time.perf_counter() - t0}
    with resp:
        buf = ""
        while True:
            chunk = resp.read(4096)
            if not chunk:
                break
            buf += chunk.decode("utf-8", errors="replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                parse_sse_chunk(obj, state)
        if buf.strip().startswith("data:"):
            data = buf.strip()[5:].strip()
            if data and data != "[DONE]":
                try:
                    parse_sse_chunk(json.loads(data), state)
                except json.JSONDecodeError:
                    pass
    content = "".join(state["content_parts"])
    reasoning = "".join(state["reasoning_parts"])
    answer, leaked = visible_answer(content)
    used_reasoning_fallback = False
    if not answer and reasoning:
        answer, leaked_r = visible_answer(reasoning)
        leaked = leaked or leaked_r
        used_reasoning_fallback = True
    return {
        "content": content,
        "reasoning_content": reasoning,
        "answer": answer,
        "thinking_leak": leaked,
        "reasoning_fallback": used_reasoning_fallback,
        "ttft_s": state["ttft_s"],
        "ttft_content_s": state["ttft_content_s"],
        "wall_s": time.perf_counter() - t0,
        "timings": state["timings"],
    }


def log_tail(path: Path, n: int = 40) -> str:
    if not path.is_file():
        return ""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-n:])


def wait_healthy(port: int, proc: subprocess.Popen, timeout_s: float, log_path: Path) -> None:
    deadline = time.time() + timeout_s
    url = f"http://127.0.0.1:{port}/health"
    last = ""
    while time.time() < deadline:
        log_f = getattr(proc, "_log_f", None)
        if log_f is not None:
            log_f.flush()
        if proc.poll() is not None:
            tail = log_tail(log_path)
            die(f"llama-server exited early with status {proc.returncode}\n{tail}")
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                last = body
                if resp.status == 200 and "ok" in body.casefold():
                    return
        except Exception as exc:  # noqa: BLE001 — server is still binding
            last = str(exc)
        time.sleep(0.4)
    tail = log_tail(log_path)
    die(f"llama-server did not become healthy on port {port}: {last}\n{tail}")


def child_pids(pid: int) -> list[int]:
    try:
        out = subprocess.check_output(["pgrep", "-P", str(pid)], text=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    return [int(part) for part in out.split() if part.strip()]


def stop_proc(proc: subprocess.Popen | None) -> None:
    """Stop llama-server without killing /usr/bin/time before it writes -o.

    time(1) is the direct child. Signalling the whole process group kills time
    before it records maximum resident set size. Signal the server, then wait
    for time to exit and flush its stats.
    """
    if proc is None or proc.poll() is not None:
        return
    kids = child_pids(proc.pid)
    targets = kids or [proc.pid]
    for pid in targets:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=20)
        return
    except subprocess.TimeoutExpired:
        pass
    for pid in child_pids(proc.pid) or targets:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.kill(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        proc.wait(timeout=10)


def read_time_stats(path: Path) -> dict:
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")
    out: dict = {"time_l_raw_tail": "\n".join(text.strip().splitlines()[-8:])}
    rss = RSS_RE.search(text)
    if rss:
        out["peak_rss_bytes"] = int(rss.group(1))
        out["peak_rss_mib"] = round(int(rss.group(1)) / (1024 * 1024), 2)
    foot = FOOTPRINT_RE.search(text)
    if foot:
        out["peak_memory_footprint_bytes"] = int(foot.group(1))
    return out


def parse_server_log(path: Path) -> dict:
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")
    off = OFFLOAD_RE.findall(text)
    return {
        "model_buffer_mib": [float(x) for x in MODEL_BUF_RE.findall(text)],
        "kv_buffer_mib": [float(x) for x in KV_BUF_RE.findall(text)],
        "compute_buffer_mib": [float(x) for x in COMPUTE_BUF_RE.findall(text)],
        "offloaded_layers": f"{off[-1][0]}/{off[-1][1]}" if off else None,
        "prompt_timings_from_log": [
            {
                "prompt_ms": float(a),
                "prompt_n": int(b),
                "prompt_per_token_ms": float(c),
                "prompt_per_second": float(d),
            }
            for a, b, c, d in PROMPT_TIMING_RE.findall(text)
        ],
        "eval_timings_from_log": [
            {
                "predicted_ms": float(a),
                "predicted_n": int(b),
                "predicted_per_token_ms": float(c),
                "predicted_per_second": float(d),
            }
            for a, b, c, d in EVAL_TIMING_RE.findall(text)
        ],
    }


def machine_info() -> dict:
    info = {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
    }
    try:
        brand = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
        mem = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip()
        info["cpu"] = brand
        info["mem_bytes"] = int(mem)
    except (OSError, subprocess.CalledProcessError, ValueError):
        pass
    return info


def backfill_timings(rows: list[dict], warmup: dict, buffers: dict) -> None:
    """Use llama-server log lines when the HTTP payload omitted timings."""
    prompt_logs = list(buffers.get("prompt_timings_from_log") or [])
    eval_logs = list(buffers.get("eval_timings_from_log") or [])
    offset = 0
    if warmup and not warmup.get("error"):
        if prompt_logs and not (warmup.get("timings") or {}).get("prompt_per_second"):
            warmup["timings"] = {
                "prompt_n": prompt_logs[0]["prompt_n"],
                "prompt_ms": prompt_logs[0]["prompt_ms"],
                "prompt_per_second": prompt_logs[0]["prompt_per_second"],
                **(eval_logs[0] if eval_logs else {}),
            }
            warmup["timings_source"] = "server_log"
        offset = 1
    if len(prompt_logs) < offset + len([r for r in rows if "error" not in r]):
        return
    cursor = offset
    for row in rows:
        if "error" in row:
            continue
        if cursor >= len(prompt_logs):
            break
        prompt = prompt_logs[cursor]
        predicted = eval_logs[cursor] if cursor < len(eval_logs) else {}
        cursor += 1
        if row.get("prompt_per_second") is None:
            row["prompt_n"] = prompt["prompt_n"]
            row["prompt_ms"] = prompt["prompt_ms"]
            row["prompt_per_second"] = prompt["prompt_per_second"]
            row["timings_source"] = "server_log"
        if row.get("predicted_per_second") is None and predicted:
            row["predicted_n"] = predicted["predicted_n"]
            row["predicted_ms"] = predicted["predicted_ms"]
            row["predicted_per_second"] = predicted["predicted_per_second"]
            row["timings_source"] = row.get("timings_source") or "server_log"


def mean(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def prompt_rate_rows(rows: list[dict]) -> tuple[list[float], list[dict]]:
    """Per-question prompt rates, dropping lines that cannot be prompt time.

    llama.cpp once reported a multi-million-millisecond prompt eval inside a
    request whose wall clock was under a minute. That rate is not a slow
    prompt. Prompt-eval time longer than the whole request is omitted.
    """
    rates: list[float] = []
    excluded: list[dict] = []
    for row in rows:
        rate = row.get("prompt_per_second")
        if not isinstance(rate, (int, float)):
            continue
        prompt_ms = row.get("prompt_ms")
        wall_s = row.get("wall_s")
        if (
            isinstance(prompt_ms, (int, float))
            and isinstance(wall_s, (int, float))
            and prompt_ms > wall_s * 1000 * 1.25
        ):
            excluded.append({
                "id": row.get("id"),
                "prompt_ms": prompt_ms,
                "prompt_n": row.get("prompt_n"),
                "prompt_per_second": rate,
                "wall_s": wall_s,
                "reason": "prompt_ms exceeds the request wall clock",
            })
            continue
        rates.append(float(rate))
    return rates, excluded


def start_server(args: argparse.Namespace, model: dict, port: int, log_path: Path, time_path: Path) -> subprocess.Popen:
    if port == FORBIDDEN_PORT:
        die(f"refusing to bind port {FORBIDDEN_PORT}")
    cmd = [
        "/usr/bin/time",
        "-l",
        "-o",
        str(time_path),
        args.llama_server,
        "-m",
        model["path"],
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "-c",
        str(args.n_ctx),
        "-np",
        "1",
        "-ngl",
        str(args.n_gpu_layers),
        "--reasoning",
        "off",
        "--jinja",
        "--no-cache-prompt",
        # Default -lv 3 drops llama.cpp's own INFO lines (they are logged as
        # trace). Level 4 keeps model/KV/compute buffer sizes and offload counts.
        "-lv",
        "4",
        "--alias",
        model["key"],
        "--temp",
        "0",
        "--seed",
        "0",
        "-t",
        str(args.threads),
    ]
    if str(FORBIDDEN_PORT) in cmd:
        die(f"command line contains forbidden port {FORBIDDEN_PORT}")
    log_f = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        cmd,
        stdout=log_f,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        cwd=str(Path(args.llama_server).parent),
    )
    proc._log_f = log_f  # type: ignore[attr-defined]
    return proc


def close_log(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    log_f = getattr(proc, "_log_f", None)
    if log_f is not None:
        log_f.close()


def run_model(args: argparse.Namespace, fixture: dict, model: dict, out_dir: Path) -> Path:
    port = free_port()
    stamp = dt.datetime.now().strftime("%H%M%S")
    # Absolute paths: llama-server is started with cwd=its bindir, and
    # /usr/bin/time resolves -o relative to that directory.
    log_path = (out_dir / f".{model['key']}-{stamp}.server.log").resolve()
    time_path = (out_dir / f".{model['key']}-{stamp}.time.txt").resolve()
    proc = None
    warmup: dict = {}
    rows: list[dict] = []
    system_prompt = fixture.get("system_prompt") or SYSTEM_PROMPT
    canaries = list(fixture.get("canaries") or [])
    try:
        print(f"starting {model['key']} on 127.0.0.1:{port}", flush=True)
        proc = start_server(args, model, port, log_path, time_path)
        wait_healthy(port, proc, args.load_timeout, log_path)
        warm_context = fixture.get("context_text") or ""
        if fixture["questions"] and fixture["questions"][0].get("context_text"):
            warm_context = fixture["questions"][0]["context_text"]
        warmup_user = render_user(warm_context, "Reply with the single word pong.")
        warmup = chat_once(port, model["key"], warmup_user, 32, system_prompt)
        warmup_blob = (warmup.get("content") or "") + "\n" + (warmup.get("reasoning_content") or "")
        warmup["canary_hits"] = canary_hits(warmup_blob, canaries)
        questions = fixture["questions"]
        if args.limit:
            questions = questions[: args.limit]
        for item in questions:
            context = item.get("context_text") or fixture.get("context_text") or ""
            user = render_user(context, item["question"], item.get("unit"))
            result = chat_once(port, model["key"], user, args.max_tokens, system_prompt)
            if "error" in result:
                if "exceeds the available context size" in result["error"]:
                    die(
                        f"{item['id']} does not fit in n_ctx={args.n_ctx}: {result['error'][:240]}"
                    )
                rows.append({
                    "id": item["id"],
                    "kind": item["kind"],
                    "key": item.get("key"),
                    "question": item["question"],
                    "read_status": item.get("read_status"),
                    "correct": False,
                    "canary_hits": [],
                    "error": result["error"],
                })
                print(f"  {item['id']}: ERROR {result['error'][:120]}", flush=True)
                continue
            ok, detail = score_expect(item["expect"], result["answer"])
            blob = (result.get("content") or "") + "\n" + (result.get("reasoning_content") or "")
            hits = canary_hits(blob, canaries)
            timings = result.get("timings") or {}
            row = {
                "id": item["id"],
                "kind": item["kind"],
                "key": item.get("key"),
                "question": item["question"],
                "read_status": item.get("read_status"),
                "correct": ok,
                "score_detail": detail,
                "answer": result["answer"],
                "content": result["content"],
                "reasoning_content": result["reasoning_content"],
                "thinking_leak": result["thinking_leak"],
                "reasoning_fallback": result["reasoning_fallback"],
                "canary_hits": hits,
                "ttft_s": None if result["ttft_s"] is None else round(result["ttft_s"], 4),
                "ttft_content_s": None if result["ttft_content_s"] is None else round(result["ttft_content_s"], 4),
                "wall_s": round(result["wall_s"], 4),
                "prompt_n": timings.get("prompt_n"),
                "prompt_ms": timings.get("prompt_ms"),
                "prompt_per_second": timings.get("prompt_per_second"),
                "predicted_n": timings.get("predicted_n"),
                "predicted_ms": timings.get("predicted_ms"),
                "predicted_per_second": timings.get("predicted_per_second"),
            }
            rows.append(row)
            leak = f" LEAK={hits}" if hits else ""
            print(
                f"  {item['id']}: {'PASS' if ok else 'FAIL'} "
                f"ttft={row['ttft_s']} gen_t/s={row['predicted_per_second']} "
                f"prompt_t/s={row['prompt_per_second']} answer={result['answer'][:140]!r}{leak}",
                flush=True,
            )
    finally:
        stop_proc(proc)
        close_log(proc)

    mem = read_time_stats(time_path)
    buffers = parse_server_log(log_path)
    backfill_timings(rows, warmup, buffers)
    by_kind: dict[str, dict] = {}
    for row in rows:
        bucket = by_kind.setdefault(row["kind"], {"correct": 0, "total": 0})
        bucket["total"] += 1
        bucket["correct"] += int(bool(row.get("correct")))
    ttfts = [r["ttft_s"] for r in rows if isinstance(r.get("ttft_s"), (int, float))]
    gen = [r["predicted_per_second"] for r in rows if isinstance(r.get("predicted_per_second"), (int, float))]
    prompt, prompt_excluded = prompt_rate_rows(rows)
    prompt_ns = [r["prompt_n"] for r in rows if isinstance(r.get("prompt_n"), (int, float))]
    leak_hits = []
    for row in rows:
        for canary in row.get("canary_hits") or []:
            leak_hits.append({"id": row["id"], "canary": canary})
    for canary in warmup.get("canary_hits") or []:
        leak_hits.append({"id": "warmup", "canary": canary})
    distinct_canaries = []
    for hit in leak_hits:
        if hit["canary"] not in distinct_canaries:
            distinct_canaries.append(hit["canary"])
    leak_questions = sorted({hit["id"] for hit in leak_hits})
    copy = fixture.get("eval_copy") or {}
    report = {
        "model_key": model["key"],
        "date": args.date,
        "fixture": {
            "id": fixture.get("id"),
            "path": str(args.fixture),
            "source": fixture.get("source"),
            "description": fixture.get("description"),
            "protocol_pin": fixture.get("pin"),
            "protocol_source": fixture.get("protocol_source"),
            "copied_from_commit": copy.get("copied_from_commit"),
            "copied_from_path": copy.get("copied_from_path"),
            "copied_from_branch": copy.get("copied_from_branch"),
            "question_count": len(fixture["questions"]),
            "canary_count": len(canaries),
        },
        "llama_cpp": {
            "commit": args.llama_commit,
            "server": args.llama_server,
            "build": "Release -DGGML_METAL=ON",
        },
        "weights": {
            "repo": model.get("repo"),
            "filename": model.get("filename"),
            "revision": model.get("revision"),
            "sha256": model.get("sha256"),
            "size_bytes": model.get("size_bytes"),
            "quant": model.get("quant", "Q4_K_M"),
            "path": model.get("path"),
        },
        "machine": machine_info(),
        "settings": {
            "temperature": 0,
            "seed": 0,
            "n_ctx": args.n_ctx,
            "parallel": 1,
            "n_gpu_layers": args.n_gpu_layers,
            "threads": args.threads,
            "reasoning": "off",
            "verbosity": 4,
            "thinking": (
                "Disabled with llama-server --reasoning off, which sets the Qwen3 "
                "chat-template kwarg enable_thinking=false. Answers are scored from "
                "message.content. A <think> block, if one is still emitted, is stripped "
                "before scoring and flagged thinking_leak. Prompt cache is off "
                "(--no-cache-prompt) so each question remeasures prompt tokens/s. "
                "One unscored warmup request runs first. -lv 4 is set so llama.cpp "
                "prints model, KV, and compute buffer sizes; its default verbosity "
                "drops those INFO lines."
            ),
            "cache_prompt": False,
            "jinja": True,
            "max_tokens": args.max_tokens,
            "host": "127.0.0.1",
            "port": port,
        },
        "memory": {
            **mem,
            **{k: buffers[k] for k in (
                "model_buffer_mib",
                "kv_buffer_mib",
                "compute_buffer_mib",
                "offloaded_layers",
            )},
            "note": (
                "peak_rss_bytes is /usr/bin/time -l maximum resident set size for the "
                "llama-server process, including model load and the questions. "
                "model/KV/compute buffer sizes are llama.cpp's own log lines. On Apple "
                "Silicon those Metal buffers live in unified memory and are largely "
                "already inside RSS, so they are reported beside RSS rather than added "
                "into a second machine total."
            ),
        },
        "accuracy": {
            "correct": sum(int(bool(r.get("correct"))) for r in rows),
            "total": len(rows),
            "by_kind": by_kind,
            "positive_control": by_kind.get("positive_control") or {"correct": 0, "total": 0},
            "unavailable": by_kind.get("unavailable") or {"correct": 0, "total": 0},
            "negative_control": by_kind.get("negative_control"),
        },
        "canary_leaks": {
            "leak_count": len(leak_hits),
            "questions_with_leak": len(leak_questions),
            "question_ids": leak_questions,
            "canaries": distinct_canaries,
            "hits": leak_hits,
            "note": (
                "leak_count is the number of (output, canary) pairs across scored "
                f"questions and the warmup. A canary is one of the {len(canaries)} strings "
                "planted in the pinned mock-node, including hex field canaries and the "
                "nested EXTRA_01 and EXTRA_02 strings. The prompt contains them; the "
                "model output must not."
            ),
        },
        "latency": {
            "ttft_s_mean": mean(ttfts),
            "ttft_s_min": None if not ttfts else round(min(ttfts), 4),
            "ttft_s_max": None if not ttfts else round(max(ttfts), 4),
            "generation_tokens_per_s_mean": mean(gen),
            "prompt_tokens_per_s_mean": mean(prompt),
            "prompt_tokens_per_s_excluded": prompt_excluded,
            "prompt_n_mean": mean(prompt_ns),
            "questions_with_timings": len(gen),
        },
        "warmup": {
            "answer": warmup.get("answer"),
            "ttft_s": None if warmup.get("ttft_s") is None else round(warmup["ttft_s"], 4),
            "timings": warmup.get("timings"),
            "error": warmup.get("error"),
            "thinking_leak": warmup.get("thinking_leak"),
            "canary_hits": warmup.get("canary_hits") or [],
        },
        "questions": rows,
        "server_log_timings": {
            "prompt": buffers.get("prompt_timings_from_log"),
            "eval": buffers.get("eval_timings_from_log"),
        },
    }
    out_path = out_dir / f"{model['key']}-{args.date}.json"
    out_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    missing_timings = any(row.get("predicted_per_second") is None and "error" not in row for row in rows)
    if missing_timings:
        debug_dir = out_dir / ".debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        for leftover, name in ((log_path, "server.log"), (time_path, "time.txt")):
            if leftover.is_file():
                target = debug_dir / f"{model['key']}-{args.date}.{name}"
                target.write_bytes(leftover.read_bytes())
        print(f"timings missing; kept logs in {debug_dir}", flush=True)
    for leftover in (log_path, time_path):
        try:
            leftover.unlink()
        except OSError:
            pass
    print(f"wrote {out_path}", flush=True)
    return out_path


def fmt_num(value, digits: int = 2) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def write_summary(out_dir: Path, fixture_note: str) -> Path:
    paths = sorted(Path(p) for p in glob.glob(str(out_dir / "*.json")))
    reports = []
    for path in paths:
        reports.append(json.loads(path.read_text(encoding="utf-8")))
    ctx = "—"
    if reports:
        ctx = str((reports[0].get("settings") or {}).get("n_ctx", "—"))
    lines = [
        "# Phase 0.5 local model eval",
        "",
        fixture_note.strip(),
        "",
        "Thinking: disabled with `llama-server --reasoning off` (`enable_thinking=false`). "
        f"Temperature 0, seed 0, `--no-cache-prompt`, context {ctx}, Metal on. "
        "Peak RSS is `/usr/bin/time -l` maximum resident set size. "
        "Metal buffer sizes are llama.cpp's figures and, on this Apple Silicon machine, "
        "sit in unified memory already covered by RSS.",
        "",
        "Positive controls must contain the fixture's expected value. "
        "Unavailable cases must say `unavailable` and must not repeat the fresh value. "
        "Canary leaks are counted separately and are not folded into the accuracy columns. "
        + (
            f"A leak is any of the {reports[0].get('fixture', {}).get('canary_count')} "
            "pinned canary strings in a model output (plaintext `JARVIS_CANARY_*` values "
            "and the hex field canaries, including nested EXTRA_01 and EXTRA_02)."
            if reports
            else "A leak is any pinned canary string in a model output."
        ),
        "",
        "| Model | Positive controls | Unavailable | Canary leaks | TTFT mean (s) | Gen tokens/s | Prompt tokens/s | Peak RSS (MiB) | Model buffers (MiB) |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    exclusions: list[tuple] = []
    for rep in reports:
        acc = rep["accuracy"]
        by = acc.get("by_kind") or {}
        pos = acc.get("positive_control") or by.get("positive_control") or {}
        unavail = acc.get("unavailable") or by.get("unavailable") or {}
        mem = rep.get("memory") or {}
        lat = rep.get("latency") or {}
        leaks = rep.get("canary_leaks") or {}
        buffers = mem.get("model_buffer_mib") or []
        buf_s = ", ".join(f"{b:.1f}" for b in buffers) if buffers else "—"
        pos_s = f"{pos.get('correct', 0)}/{pos.get('total', 0)}" if pos else "—"
        unavail_s = f"{unavail.get('correct', 0)}/{unavail.get('total', 0)}" if unavail else "—"
        leak_n = leaks.get("leak_count")
        leak_s = "—" if leak_n is None else str(leak_n)
        prompt_rates, prompt_excluded = prompt_rate_rows(rep.get("questions") or [])
        prompt_mean = mean(prompt_rates) if prompt_rates else lat.get("prompt_tokens_per_s_mean")
        if prompt_excluded:
            exclusions.append((rep.get("model_key"), prompt_excluded))
        lines.append(
            "| {model} | {pos} | {unavail} | {leaks} | {ttft} | {gen} | {prompt} | {rss} | {buf} |".format(
                model=rep.get("model_key"),
                pos=pos_s,
                unavail=unavail_s,
                leaks=leak_s,
                ttft=fmt_num(lat.get("ttft_s_mean"), 3),
                gen=fmt_num(lat.get("generation_tokens_per_s_mean"), 2),
                prompt=fmt_num(prompt_mean, 2),
                rss=fmt_num(mem.get("peak_rss_mib"), 1),
                buf=buf_s,
            )
        )
    lines.append("")
    lines.append(
        "KV and compute buffers are llama.cpp's own figures. Offload is layers on the GPU. "
        "Peak RSS is `/usr/bin/time -l` maximum resident set size for the whole server lifetime "
        "(load plus every question), which on this machine also covers unified Metal memory."
    )
    for rep in reports:
        mem = rep.get("memory") or {}
        kv = mem.get("kv_buffer_mib") or []
        compute = mem.get("compute_buffer_mib") or []
        kv_s = ", ".join(f"{b:.1f}" for b in kv) if kv else "—"
        compute_s = ", ".join(f"{b:.1f}" for b in compute) if compute else "—"
        lines.append(
            f"- **{rep.get('model_key')}**: KV {kv_s} MiB, compute {compute_s} MiB, "
            f"offload {mem.get('offloaded_layers') or '—'}."
        )
    if exclusions:
        lines.append("")
        lines.append(
            "Prompt tokens/s is the unweighted mean of per-question llama.cpp rates. "
            "A sample is omitted when the reported prompt-eval time is longer than the "
            "request wall clock."
        )
        for model_key, skipped in exclusions:
            bits = []
            for item in skipped:
                bits.append(
                    f"{item.get('id')} (prompt_ms {item.get('prompt_ms')}, "
                    f"wall {item.get('wall_s')} s)"
                )
            lines.append(f"- **{model_key}**: omitted {', '.join(bits)}.")
    lines.extend(["", "## Canary leaks", ""])
    any_leak = False
    for rep in reports:
        leaks = rep.get("canary_leaks") or {}
        hits = leaks.get("hits") or []
        if not hits:
            lines.append(f"- **{rep.get('model_key')}**: 0 leaks.")
            continue
        any_leak = True
        lines.append(
            f"- **{rep.get('model_key')}**: {leaks.get('leak_count')} leak(s) "
            f"across {leaks.get('questions_with_leak')} output(s): "
            + ", ".join(f"`{canary}`" for canary in (leaks.get("canaries") or []))
        )
        for hit in hits:
            lines.append(f"  - `{hit.get('id')}`: `{hit.get('canary')}`")
    if not reports:
        lines.append("No result JSON yet.")
    if any_leak:
        lines.append("")
        lines.append("Listed canaries appeared in model output. They are planted fake strings, not secrets.")
    lines.extend(["", "## Provenance", ""])
    for rep in reports:
        w = rep.get("weights") or {}
        ll = rep.get("llama_cpp") or {}
        lines.append(
            f"- **{rep.get('model_key')}**: `{w.get('repo')}` `{w.get('filename')}` "
            f"revision `{w.get('revision')}` sha256 `{w.get('sha256')}` "
            f"size {w.get('size_bytes')} bytes. llama.cpp `{ll.get('commit')}`."
        )
    lines.extend(["", "## Per question", ""])
    if reports:
        header = "| Question | Kind | " + " | ".join(r.get("model_key", "?") for r in reports) + " |"
        sep = "|---|---|" + "|".join("---:" for _ in reports) + "|"
        lines.extend([header, sep])
        ids = [q["id"] for q in reports[0].get("questions") or []]
        for qid in ids:
            kind = ""
            cells = []
            for rep in reports:
                row = next((q for q in rep.get("questions") or [] if q.get("id") == qid), None)
                if row is None:
                    cells.append("—")
                    continue
                kind = row.get("kind") or kind
                mark = "pass" if row.get("correct") else "fail"
                cells.append(mark)
            lines.append("| " + " | ".join([qid, kind, *cells]) + " |")
    lines.append("")
    summary = out_dir / "SUMMARY.md"
    summary.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {summary}", flush=True)
    return summary


def load_models(provenance: Path, keys: list[str]) -> list[dict]:
    data = json.loads(provenance.read_text(encoding="utf-8"))
    models = data.get("models") or []
    by_key = {m["key"]: m for m in models}
    missing = [k for k in keys if k not in by_key]
    if missing:
        die(f"provenance {provenance} has no {missing}")
    selected = []
    for key in keys:
        model = by_key[key]
        path = model.get("path")
        if not path or not os.path.isfile(path):
            die(f"weights missing for {key}: {path}")
        selected.append(model)
    return selected


def self_test() -> None:
    alias_ok, _ = score_expect(
        {"match": "contains_all", "values": ["mock-northwind-07"]},
        "The node_alias is mock-northwind-07.",
    )
    alias_bad, _ = score_expect(
        {"match": "contains_all", "values": ["mock-northwind-07"]},
        "I don't know.",
    )
    num_ok, _ = score_expect({"match": "number", "value": 1234567}, "The balance is 1,234,567 sats.")
    num_bad, _ = score_expect({"match": "number", "value": 1234567}, "The balance is 0 sats.")
    num_prefix, _ = score_expect({"match": "number", "value": 65000}, "650000")
    cedar_ok, _ = score_expect(
        {"match": "contains_any", "values": ["inactive", "not active", "false", "no"], "forbid_words": ["yes"]},
        "No. Channel mock-ch-cedar-3 is inactive.",
    )
    cedar_yes, _ = score_expect(
        {"match": "contains_any", "values": ["inactive", "not active", "false", "no"], "forbid_words": ["yes"]},
        "Yes, it is active.",
    )
    cedar_north, _ = score_expect(
        {"match": "contains_any", "values": ["inactive", "not active", "false", "no"], "forbid_words": ["yes"]},
        "The alias is mock-northwind-07.",
    )
    sum_ok, _ = score_expect({"match": "number", "value": 650000}, "650000")
    abs_ok, detail_ok = score_expect({"match": "abstain"}, "unavailable")
    abs_zero, _ = score_expect({"match": "abstain"}, "0 messages")
    abs_num, _ = score_expect({"match": "abstain"}, "There were 4 messages.")
    abs_not_zero, detail_nz = score_expect(
        {"match": "abstain"},
        "unavailable. The context does not include a count, so this is not 0 messages.",
    )
    abs_dont, _ = score_expect({"match": "abstain"}, "I don't know.")
    unavail_ok, _ = score_expect(
        {"match": "unavailable", "fresh_value": "150000"},
        "unavailable",
    )
    unavail_word, _ = score_expect(
        {"match": "unavailable", "fresh_value": "150000"},
        "The read failed, so the answer is unavailable.",
    )
    unavail_fresh, _ = score_expect(
        {"match": "unavailable", "fresh_value": "150000"},
        "unavailable. It would have been 150000 sats.",
    )
    unavail_zero, _ = score_expect(
        {"match": "unavailable", "fresh_value": "150000"},
        "0",
    )
    unavail_text, _ = score_expect(
        {"match": "unavailable", "fresh_value": "ldk"},
        "unavailable",
    )
    unavail_text_hit, _ = score_expect(
        {"match": "unavailable", "fresh_value": "ldk"},
        "unavailable, the backend is ldk",
    )
    pos_forbid, _ = score_expect(
        {"match": "number", "value": 150000, "forbid_words": ["unavailable"]},
        "unavailable",
    )
    leaked = canary_hits(
        "balance is 1 JARVIS_CANARY_MEMO_01 and JARVIS_CANARY_MEMO_01",
        ["JARVIS_CANARY_MEMO_01", "JARVIS_CANARY_ALIAS_01"],
    )
    checks = {
        "alias_ok": alias_ok,
        "alias_bad": not alias_bad,
        "num_ok": num_ok,
        "num_bad": not num_bad,
        "num_prefix": not num_prefix,
        "cedar_ok": cedar_ok,
        "cedar_yes": not cedar_yes,
        "cedar_north": not cedar_north,
        "sum_ok": sum_ok,
        "abs_ok": abs_ok,
        "abs_zero": not abs_zero,
        "abs_num": not abs_num,
        "abs_not_zero": abs_not_zero,
        "abs_dont": abs_dont,
        "unavail_ok": unavail_ok,
        "unavail_word": unavail_word,
        "unavail_fresh": not unavail_fresh,
        "unavail_zero": not unavail_zero,
        "unavail_text": unavail_text,
        "unavail_text_hit": not unavail_text_hit,
        "pos_forbid": not pos_forbid,
        "canary_one": leaked == ["JARVIS_CANARY_MEMO_01"],
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        print(json.dumps({"checks": checks, "detail_ok": detail_ok, "detail_nz": detail_nz}, indent=2))
        die("self-test failed: " + ", ".join(failed))
    if len(mock_context.CANARIES) != 20:
        die(f"expected 20 canaries, found {len(mock_context.CANARIES)}")
    if "JARVIS_CANARY_EXTRA_01" not in mock_context.CANARIES:
        die("EXTRA_01 missing from the canary list")
    if "JARVIS_CANARY_EXTRA_02" not in mock_context.CANARIES:
        die("EXTRA_02 missing from the canary list")
    mock_context.self_check()
    fixture = load_fixture(mock_context.fixture_path())
    if len(fixture["questions"]) != 50:
        die("j1 fixture did not load 50 questions")
    if len(fixture["canaries"]) != 20:
        die("loaded fixture is not scanning 20 canaries")
    if fixture["questions"][0]["kind"] != "positive_control":
        die("j1 q01 was not scored as a positive control")
    if fixture["questions"][32]["kind"] != "unavailable":
        die("j1 q33 was not scored as unavailable")
    by_id = {q["id"]: q for q in fixture["questions"]}
    if by_id["q20"]["expect"].get("value") != 6:
        die("q20 is not scored as the whole-mailbox count 6")
    if by_id["q25"]["expect"].get("value") != 4:
        die("q25 is not scored as the whole-mailbox chat count 4")
    if "JARVIS_CANARY_EXTRA_01" not in by_id["q33"]["context_text"]:
        die("q33 error exchange does not carry EXTRA_01")
    if "JARVIS_CANARY_EXTRA_02" not in by_id["q33"]["context_text"]:
        die("q33 error exchange does not carry EXTRA_02")
    if '"stale": true' not in by_id["q45"]["context_text"]:
        die("q45 context has no Exchange.stale flag")
    if mock_context.FIXTURE_COMMIT not in (fixture.get("source") or ""):
        die("fixture source does not record 8cc34eb")
    port = free_port()
    if port == FORBIDDEN_PORT:
        die("self-test allocated the forbidden port")
    print("self-test passed", flush=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score a local GGUF model on a mock-node question fixture.")
    parser.add_argument("--fixture", type=Path, help="Question fixture JSON.")
    parser.add_argument("--provenance", type=Path, help="PROVENANCE.json written next to the weights.")
    parser.add_argument("--model", action="append", dest="models", default=[], help="Model key in the provenance file. Repeatable.")
    parser.add_argument("--llama-server", help="Path to the llama-server binary.")
    parser.add_argument("--llama-commit", default="", help="llama.cpp commit recorded in the result.")
    parser.add_argument("--out-dir", type=Path, default=Path("eval/results"))
    parser.add_argument("--date", default=dt.date.today().isoformat())
    parser.add_argument(
        "--n-ctx",
        type=int,
        default=16384,
        help="Context size. 16384 fits the Exchange JSON (about 8600 prompt tokens) plus the reply.",
    )
    parser.add_argument("--n-gpu-layers", type=int, default=99)
    parser.add_argument("--threads", type=int, default=10)
    parser.add_argument("--max-tokens", type=int, default=192)
    parser.add_argument("--limit", type=int, default=0, help="Score only the first N questions. 0 means all.")
    parser.add_argument("--load-timeout", type=float, default=180)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--summary-only", action="store_true", help="Rebuild SUMMARY.md from result JSON already in --out-dir.")
    parser.add_argument("--fixture-note", default="", help="Paragraph placed at the top of SUMMARY.md.")
    args = parser.parse_args(argv)
    return args


def main(argv: list[str]) -> None:
    args = parse_args(argv)
    if args.self_test:
        self_test()
        if not args.models:
            return
    if args.summary_only:
        note = args.fixture_note or "Summary rebuilt from existing result JSON."
        write_summary(args.out_dir, note)
        return
    if not args.fixture or not args.provenance or not args.models or not args.llama_server:
        die("need --fixture, --provenance, --llama-server, and at least one --model (or --self-test)")
    if not os.path.isfile(args.llama_server):
        die(f"llama-server not found: {args.llama_server}")
    if not os.access(args.llama_server, os.X_OK):
        die(f"llama-server is not executable: {args.llama_server}")
    fixture = load_fixture(args.fixture)
    models = load_models(args.provenance, args.models)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for model in models:
        run_model(args, fixture, model, args.out_dir)
    note = args.fixture_note or (
        f"Fixture `{fixture.get('id')}` from `{args.fixture}`. {fixture.get('source') or ''}"
    )
    write_summary(args.out_dir, note)


if __name__ == "__main__":
    main(sys.argv[1:])
