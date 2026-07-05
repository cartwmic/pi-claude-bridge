#!/usr/bin/env python3
"""Raw Ink echo probe for claude-p PromptNotAccepted spike.

Spawns the real interactive `claude` binary in a PTY, waits briefly for Ink to
render, writes a prompt WITHOUT pressing Enter, captures raw terminal output,
then kills the child. This does not submit a Claude turn; it only observes how
Ink echoes typed text in the input box.
"""
import argparse, os, pty, select, signal, subprocess, sys, time, uuid, re

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="claude-opus-4-8")
parser.add_argument("--prompt", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--boot-wait", type=float, default=1.2)
parser.add_argument("--after-wait", type=float, default=1.5)
args = parser.parse_args()

master, slave = pty.openpty()
cmd = [
    "claude",
    "--model", args.model,
    "--system-prompt", "You are a helpful assistant.",
    "--setting-sources", "",
    "--permission-mode", "bypassPermissions",
    "--session-id", str(uuid.uuid4()),
]
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
os.set_blocking(master, False)
raw = bytearray()

def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                raw.extend(chunk)
            except BlockingIOError:
                pass
            except OSError:
                break

try:
    drain(args.boot_wait)
    os.write(master, args.prompt.encode())
    drain(args.after_wait)
finally:
    try:
        os.write(master, b"\x03")
        time.sleep(0.1)
    except OSError:
        pass
    try:
        proc.terminate()
        proc.wait(timeout=1)
    except Exception:
        try: proc.kill()
        except Exception: pass
    try: os.close(master)
    except OSError: pass

os.makedirs(args.out, exist_ok=True)
raw_path = os.path.join(args.out, "raw-pty.bin")
txt_path = os.path.join(args.out, "raw-pty-visible.txt")
open(raw_path, "wb").write(raw)
# Remove CSI for a human-readable companion while preserving text.
text = raw.decode("utf-8", "replace")
visible = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
visible = visible.replace("\r", "\n")
open(txt_path, "w", encoding="utf-8").write(visible)
print(f"wrote {len(raw)} bytes to {raw_path}")
for needle in ["Pasted text", "Pasted", args.prompt[:48]]:
    print(f"contains {needle!r}: {needle in visible}")
