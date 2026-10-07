import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

core = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(tempfile.mkdtemp(prefix="pi-role-warning-terminal-"))
try:
    for entries in [["src/index.js"], ["subagents/index.js"], ["src/index.js", "subagents/index.js"]]:
        cwd = root / str(len(list(root.iterdir())))
        agent = cwd / "agent"
        cwd.mkdir()
        (agent / "pi-extensible-workflows/roles").mkdir(parents=True)
        (agent / "pi-extensible-workflows/roles/old.md").write_text("Legacy role")
        (agent / "settings.json").write_text(json.dumps({"defaultProvider": "fixture", "defaultModel": "model", "cacheWarming": "off", "defaultProjectTrust": "never", "theme": "dark"}))
        (agent / "SYSTEM.md").write_text("UNCHANGED_WARNING_SESSION")
        events = cwd / "events.jsonl"
        fixture = cwd / "fixture.mjs"
        fixture.write_text("""import {appendFileSync} from 'node:fs';
export default function(api) {
const log=value=>appendFileSync(%s,JSON.stringify(value)+'\\n');
log({type:'factory'});
api.registerProvider('fixture',{api:'openai-completions',baseUrl:'http://127.0.0.1:1',apiKey:'fixture',models:[{id:'model',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024}]});
api.on('session_start',(event,ctx)=>log({type:'start',prompt:ctx.getSystemPrompt(),tools:api.getActiveTools()}));
api.on('session_shutdown',()=>log({type:'shutdown'}));
}
""" % json.dumps(str(events)))
        env = {**os.environ, "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0", "PI_CODING_AGENT_DIR": str(agent), "HOME": str(cwd), "XDG_CACHE_HOME": str(cwd / "cache"), "TERM": "xterm-256color"}
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 140, 0, 0))
        args = ["pi", "--no-session", "--tui-mode", "regular", "--no-extensions", "-e", str(fixture)]
        for entry in entries:
            args.extend(["-e", str(core / "dist" / entry)])
        process = subprocess.Popen(args, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = b""
        sent = False
        deadline = time.monotonic() + 30
        try:
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    break
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                output += data
                if not sent and b"Legacy role sources:" in output and b"old.md" in output and b"\x1b[?2004h" in output:
                    os.write(master, b"\x04")
                    sent = True
            code = process.wait(timeout=5)
            assert sent and code == 0, (entries, code, output[-6000:])
            log = [json.loads(line) for line in events.read_text().splitlines()]
            assert [event["type"] for event in log] == ["factory", "start", "shutdown"], log
            assert "UNCHANGED_WARNING_SESSION" in log[1]["prompt"], log
            assert {"read", "bash", "edit", "write"}.issubset(log[1]["tools"]), log
            print(json.dumps({"entries": entries, "exit": code, "warning_rendered": True, "legacy_path_rendered": True, "bytes_rendered": len(output), "lifecycle": [event["type"] for event in log]}))
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
finally:
    shutil.rmtree(root)
