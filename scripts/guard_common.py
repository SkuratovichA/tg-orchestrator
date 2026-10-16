"""Shared plumbing of the read-only launchd guards (dm-guard.py, gh-guard.py).

A guard notices what is new in some source, asks a tool-less `claude -p` whether
it matters by the guard's own `criteria.md`, and wakes the orchestrator topic
through wake.sh only when it does. What is common to every guard lives here:
state files, the log, the wake, the classifier call, the `until` expiry wake
and the failure counter that wakes the topic when the guard itself breaks.

Stdlib only, so any guard can import it whatever venv it runs in (>= 3.10).
"""
import datetime as dt
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent


class ClassifierUnavailable(RuntimeError):
    """The classifier's account cannot answer at all: weekly/usage limit, 429.

    Not a broken guard and not a batch to drop. A filter that cannot judge
    escalates the batch raw (uncertain) instead of going silent, and does not
    burn `fails` slots — retrying inside a closed limit window never succeeds,
    and the 3-failure wake would fire again every FAIL_REWAKE_EVERY runs with
    nothing new to say.
    """


QUOTA_MARKERS = ('"api_error_status":429', "weekly limit", "usage limit", "rate limit")


def is_quota_error(detail: str) -> bool:
    low = detail.lower()
    return any(m in low for m in QUOTA_MARKERS)


FAIL_WAKE_AT = 3
FAIL_REWAKE_EVERY = 36
CLASSIFIER_TIMEOUT_SEC = 300


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json_atomic(path: Path, data) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def log(guard: Path, line: str) -> None:
    with (guard / "guard.log").open("a", encoding="utf-8") as f:
        f.write(f"{now_utc().isoformat(timespec='seconds')} {line}\n")


def wake(cfg: dict, kind: str, job: str, text: str, ok: bool) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(text)
    cmd = [str(HERE / "wake.sh"), "--convo", cfg["convo"], "--kind", kind, "--job", job,
           "--ok" if ok else "--fail", "--text-file", f.name]
    subprocess.run(cmd, check=True, timeout=60)


def run_classifier(cfg: dict, guard: Path, system_prompt: str, prompt: str) -> dict:
    """One tool-less `claude -p` call; returns the verdict dict with boolean flags.

    Model and effort come from the guard's config (`model`, default opus;
    `effort`, default high, `null` omits the flag).
    """
    env = dict(os.environ)
    env["PATH"] = f"{Path.home()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    cmd = ["claude", "-p", "--model", cfg.get("model", "opus")]
    effort = cfg.get("effort", "high")
    if effort:
        cmd += ["--effort", effort]
    cmd += ["--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json",
            "--system-prompt", system_prompt]
    res = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=CLASSIFIER_TIMEOUT_SEC,
                         cwd=str(guard), env=env)
    if res.returncode != 0:
        detail = (res.stderr or res.stdout)[-400:]
        if is_quota_error(detail):
            raise ClassifierUnavailable(f"claude rc={res.returncode}: {detail}")
        raise RuntimeError(f"claude rc={res.returncode}: {detail}")
    envelope = json.loads(res.stdout)
    if envelope.get("is_error"):
        detail = str(envelope.get("result"))[:400]
        if is_quota_error(detail):
            raise ClassifierUnavailable(f"claude error result: {detail}")
        raise RuntimeError(f"claude error result: {detail}")
    raw = str(envelope.get("result", "")).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < 0:
        raise ValueError(f"classifier returned no JSON: {raw[:300]}")
    verdict = json.loads(raw[start:end + 1])
    if not isinstance(verdict.get("important"), bool) or not isinstance(verdict.get("uncertain"), bool):
        raise ValueError(f"classifier verdict has no boolean flags: {raw[:300]}")
    return verdict


def unavailable_verdict(exc: ClassifierUnavailable) -> dict:
    """What a batch is escalated with when the classifier's account is out of quota."""
    return {"important": False, "uncertain": True, "category": "classifier-unavailable",
            "reason": f"Классификатор не отвечает, лимит аккаунта: {exc}"[:300],
            "digest": "Пачка не отфильтрована — судить придётся оркестратору."}


def expired(cfg: dict, guard: Path, state: dict, kind: str, dry_run: bool, watching: str) -> bool:
    """True once past `until`: the guard stops; the first such run wakes the topic once.

    `watching` finishes the sentence "…и больше не <watching>" ("читает чат").
    """
    until = dt.datetime.fromisoformat(cfg["until"]).replace(tzinfo=dt.timezone.utc)
    if now_utc() > until and not dry_run:
        if not state.get("expired_woken"):
            wake(cfg, kind, f"{kind} {cfg['label']}: срок сторожа истёк",
                 f"Сторож «{cfg['label']}» дошёл до своей даты {cfg['until']} и больше не {watching}. "
                 f"Реши: продлить (config.json → until) или снять (launchctl unload + удалить plist). "
                 f"Каталог: {guard}", ok=True)
            state["expired_woken"] = True
            save_json_atomic(guard / "state.json", state)
        return True
    return False


def run_counting_failures(guard: Path, kind: str, dry_run: bool, body: Callable[[], None],
                          default_state: Callable[[], dict]) -> None:
    """Run one guard pass; count consecutive failures in state.json and wake on them.

    FAIL_WAKE_AT failures in a row wake the topic with --fail, then again every
    FAIL_REWAKE_EVERY runs; a clean run resets the counter. Dry runs just raise.
    """
    try:
        body()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — every failure path must be counted and, in time, reported
        if dry_run:
            raise
        state = load_json(guard / "state.json", default_state())
        state["fails"] = int(state.get("fails", 0)) + 1
        save_json_atomic(guard / "state.json", state)
        log(guard, f"FAILED #{state['fails']}: {type(e).__name__}: {e}")
        fails = state["fails"]
        if fails == FAIL_WAKE_AT or (fails > FAIL_WAKE_AT and (fails - FAIL_WAKE_AT) % FAIL_REWAKE_EVERY == 0):
            cfg = load_json(guard / "config.json", {})
            if cfg.get("convo"):
                wake(cfg, kind, f"{kind} {cfg.get('label', guard.name)}: сторож не работает ({fails} сбоев подряд)",
                     f"{type(e).__name__}: {e}\nЛог: {guard}/guard.log", ok=False)
        raise SystemExit(1)
    else:
        state = load_json(guard / "state.json", None)
        if state and state.get("fails") and not dry_run:
            state["fails"] = 0
            save_json_atomic(guard / "state.json", state)
