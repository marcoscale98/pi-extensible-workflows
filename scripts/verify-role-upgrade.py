import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

repo = pathlib.Path(__file__).resolve().parents[1]
logs = repo / ".tmp/roles-release/logs"
logs.mkdir(parents=True, exist_ok=True)
node_bin = pathlib.Path(shutil.which("node")).parent
npm = shutil.which("npm")
requests = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(request)
        messages = request["messages"]
        child = "CHILD_REQUEST" in json.dumps(messages)
        last_tool = messages[-1]["role"] == "tool"
        if not last_tool:
            if child:
                name, arguments = "workflow_result", {"result": "verified"}
            else:
                name, arguments = "read", {"path": "sample.txt"}
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "result", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]}
            finish = "tool_calls"
        else:
            delta, finish = {"role": "assistant", "content": "verified"}, "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for payload in [
            {"id": "test", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {"id": "test", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]:
            self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))


def run(args, env, cwd, label, success=True):
    result = subprocess.run([str(arg) for arg in args], env=env, cwd=cwd, capture_output=True, text=True, timeout=180)
    (logs / (label + ".log")).write_text(result.stdout + result.stderr)
    if success:
        assert result.returncode == 0, (label, result.returncode, result.stdout[-2000:], result.stderr[-3000:])
    return result


def tui(args, env, cwd, events, label, warning=False):
    events.unlink(missing_ok=True)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 140, 0, 0))
    process = subprocess.Popen([str(arg) for arg in args], cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = b""
    reloaded = closed = False
    deadline = time.monotonic() + 45
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
            starts = [json.loads(line) for line in events.read_text().splitlines() if json.loads(line)["type"] == "start"] if events.exists() else []
            if not reloaded and starts and b"\x1b[?2004h" in output:
                os.write(master, b"/reload\r")
                reloaded = True
            elif not closed and len(starts) >= 2 and b"Reloaded" in output:
                os.write(master, b"\x04")
                closed = True
        code = process.wait(timeout=5)
        assert reloaded and closed and code == 0, (label, code, output[-4000:])
        assert (b"Legacy role sources:" in output) == warning, (label, output[-4000:])
        assert b"Failed to load extension" not in output and b"Duplicate workflow" not in output, output[-4000:]
        if pathlib.Path(args[0]).name == "pi-role":
            assert all(event["tools"] == ["read"] and "INDEPENDENT_ROLE_PROMPT" in event["prompt"] for event in starts), starts
        print(json.dumps({"check": label, "exit": code, "reload": True, "warning": warning, "bytes_rendered": len(output)}))
    finally:
        (logs / (label + ".log")).write_bytes(output)
        if events.exists():
            shutil.copyfile(events, logs / (label + "-events.jsonl"))
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        os.close(master)


def verify(base, server):
    home, agent, cwd, prefix = [base / name for name in ["home", "agent", "project", "prefix"]]
    for directory in [home, agent, cwd, prefix]:
        directory.mkdir()
    env = {
        "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent),
        "XDG_CONFIG_HOME": str(base / "config"), "XDG_CACHE_HOME": str(base / "cache"),
        "NPM_CONFIG_CACHE": str(base / "cache/npm"), "NPM_CONFIG_USERCONFIG": "/dev/null",
        "NPM_CONFIG_PREFIX": str(prefix), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1",
        "PI_TELEMETRY": "0", "TERM": "xterm-256color",
        "PATH": str(prefix / "bin") + ":" + str(node_bin) + ":/usr/bin:/bin",
    }
    run([npm, "install", "--global", "--no-audit", "--no-fund", "@earendil-works/pi-coding-agent@1.0.2", "@piewf/pi-ext-roles@0.1.2"], env, cwd, "fresh-install")
    pi, role = prefix / "bin/pi", prefix / "bin/pi-role"
    assert "1.0.2" in run([pi, "--version"], env, cwd, "pi-version").stdout
    modules = prefix / "lib/node_modules"
    assert not (modules / "pi-extensible-workflows").exists()
    assert not (modules / "@piewf/cli").exists()
    run([pi, "install", "npm:@piewf/pi-ext-roles@0.1.2"], env, cwd, "fresh-pi-package-install")
    listed = run([role, "--list"], env, cwd, "fresh-role-list").stdout
    assert all(name in listed for name in ["developer", "oracle", "researcher", "reviewer", "scout"])
    assert "developer-model" not in listed
    put(agent / "settings.json", {**json.loads((agent / "settings.json").read_text()), "defaultProvider": "fixture", "defaultModel": "model", "cacheWarming": "off", "defaultProjectTrust": "never"})
    put(agent / "models.json", {"providers": {"fixture": {"baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions", "apiKey": "fixture", "models": [{"id": "model", "name": "Fixture", "reasoning": False, "input": ["text"], "contextWindow": 8192, "maxTokens": 128}]}}})
    put(agent / "AGENTS.md", "GLOBAL_CONTEXT_MUST_BE_EXCLUDED")
    put(agent / "pi-ext-roles/settings.json", {"modelAliases": {"choice": "fixture/model:off"}})
    put(agent / "pi-ext-roles/roles/unit.md", '---\nmodel: choice\ntools: ["!*", "read"]\ncontextFiles: []\n---\nINDEPENDENT_ROLE_PROMPT')
    put(cwd / "sample.txt", "ISOLATED_FILE_CONTENT")
    requests.clear()
    printed = run([role, "unit", "--no-session", "-p", "Inspect"], env, cwd, "fresh-role-model-tool")
    assert "verified" in printed.stdout
    assert len(requests) == 2
    assert [tool["function"]["name"] for tool in requests[0]["tools"]] == ["read"]
    assert "INDEPENDENT_ROLE_PROMPT" in json.dumps(requests[0]["messages"])
    assert "GLOBAL_CONTEXT_MUST_BE_EXCLUDED" not in json.dumps(requests[0]["messages"])
    assert "ISOLATED_FILE_CONTENT" in json.dumps(requests[1]["messages"])
    requests.clear()
    run([role, "unit", "--no-tools", "--no-session", "-p", "Inspect"], env, cwd, "fresh-no-tools")
    assert not requests[0].get("tools")
    assert "ISOLATED_FILE_CONTENT" not in json.dumps(requests)
    assert "not found" in json.dumps(requests).lower() or "unknown tool" in json.dumps(requests).lower()
    events = base / "events.jsonl"
    put(agent / "extensions/audit.js", "import {appendFileSync} from 'node:fs'; export default pi => { pi.on('session_start', (event,ctx) => appendFileSync(" + json.dumps(str(events)) + ", JSON.stringify({type:'start',settings:event.settings,prompt:ctx.getSystemPrompt(),tools:pi.getActiveTools()})+'\\n')); };")
    tui([pi, "--no-session", "--tui-mode", "regular"], env, cwd, events, "fresh-stock-tui")
    stock = [json.loads(line) for line in events.read_text().splitlines()]
    assert all({"read", "bash", "edit", "write"}.issubset(event["tools"]) and "INDEPENDENT_ROLE_PROMPT" not in event["prompt"] for event in stock), stock
    for mode in ["regular", "fullscreen"]:
        tui([role, "unit", "--no-session", "--tui-mode", mode], env, cwd, events, "fresh-tui-" + mode)
    print(json.dumps({"check": "fresh-registry-install", "pi": "1.0.2", "roles": "0.1.2", "isolated_environment": True, "native_model_and_read": True, "no_tools_rejected_read": True}))
    if len(sys.argv) == 1:
        return
    tarballs = pathlib.Path(sys.argv[1]).resolve()
    version = json.loads((repo / "package.json").read_text())["version"]
    candidates = [tarballs / f"{name}-{version}.tgz" for name in ["pi-extensible-workflows", "piewf-cli"]]
    assert all(path.is_file() for path in candidates), candidates
    run([pi, "remove", "npm:@piewf/pi-ext-roles@0.1.2"], env, cwd, "remove-independent-plugin")
    run([npm, "uninstall", "--global", "@piewf/pi-ext-roles"], env, cwd, "remove-independent-binary")
    shutil.rmtree(agent / "pi-ext-roles")
    run([npm, "install", "--global", "--no-audit", "--no-fund", "pi-extensible-workflows@5.19.1", "@piewf/cli@5.19.1"], env, cwd, "previous-release-install")
    core = modules / "pi-extensible-workflows"
    cli = prefix / "bin/piewf"
    assert role.resolve() == (modules / "@piewf/cli/dist/src/pi-role.js").resolve()
    run([pi, "install", core], env, cwd, "previous-pi-package-install")
    legacy_role = agent / "pi-extensible-workflows/roles/migration.md"
    legacy_settings = agent / "pi-extensible-workflows/settings.json"
    put(legacy_role, '---\nmodel: legacy-choice\ntools: ["!*", "read"]\ncontextFiles: []\nextensionSettings: {"upgrade":{"enabled":true}}\n---\nLEGACY_ROLE_PROMPT')
    put(legacy_settings, {"modelAliases": {"legacy-choice": "fixture/model:off"}, "tools": ["!*", "read"]})
    preserved = {path: path.read_bytes() for path in [legacy_role, legacy_settings]}
    workflow = cwd / "upgrade.js"
    put(workflow, 'return await agent("CHILD_REQUEST", {role: "migration"});')

    def check_workflow(label, marker="LEGACY_ROLE_PROMPT", approve=None):
        requests.clear()
        result = run([cli, "run", "--script", workflow, "--name", label] + ([] if approve is None else ["--approve" if approve else "--no-approve"]), env, cwd, label)
        assert "verified" in result.stdout, result.stdout
        assert requests and requests[0]["model"] == "model"
        assert marker in json.dumps(requests[0]["messages"])
        tools = [tool["function"]["name"] for tool in requests[0]["tools"]]
        assert "workflow_result" in tools and "read" in tools and "write" not in tools and "bash" not in tools, tools

    check_workflow("previous-legacy-workflow")
    # Both packages are replaced together; core satisfies the CLI's unpublished major dependency.
    run([npm, "install", "--global", "--no-audit", "--no-fund", *candidates], env, cwd, "candidate-global-upgrade")
    assert json.loads((core / "package.json").read_text())["version"] == version
    assert json.loads((modules / "@piewf/cli/package.json").read_text())["version"] == version
    assert not os.path.lexists(role), "The upgraded CLI left its old pi-role binary behind"
    check_workflow("upgraded-legacy-workflow")
    tui([pi, "--no-session", "--tui-mode", "regular"], env, cwd, events, "upgraded-legacy-tui", warning=True)
    for path, content in preserved.items():
        assert path.read_bytes() == content, path
    # Consumer settings delivery is checked in a real child session, not CLI argv.
    events.unlink()
    check_workflow("upgraded-settings-delivery")
    starts = [json.loads(line) for line in events.read_text().splitlines()]
    assert any(event.get("settings", {}).get("upgrade", {}).get("enabled") is True for event in starts), starts

    # New paths win without removing legacy files. Unauthorized project sources stay hidden.
    put(agent / "pi-ext-roles/roles/migration.md", legacy_role.read_text().replace("LEGACY_ROLE_PROMPT", "NEW_GLOBAL_ROLE_PROMPT"))
    check_workflow("new-global-precedence", "NEW_GLOBAL_ROLE_PROMPT")
    put(cwd / ".pi/pi-extensible-workflows/roles/migration.md", legacy_role.read_text().replace("LEGACY_ROLE_PROMPT", "LEGACY_PROJECT_ROLE_PROMPT"))
    put(cwd / ".pi/pi-ext-roles/roles/migration.md", legacy_role.read_text().replace("LEGACY_ROLE_PROMPT", "NEW_PROJECT_ROLE_PROMPT"))
    check_workflow("explicit-no-approve-excludes-project", "NEW_GLOBAL_ROLE_PROMPT", approve=False)
    assert "NEW_PROJECT_ROLE_PROMPT" not in json.dumps(requests)
    # Pi's automatic trust gate detects native .pi resources, not custom role directories alone.
    put(cwd / ".pi/settings.json", {})
    check_workflow("default-never-excludes-project", "NEW_GLOBAL_ROLE_PROMPT")
    assert "NEW_PROJECT_ROLE_PROMPT" not in json.dumps(requests)
    check_workflow("trusted-project-precedence", "NEW_PROJECT_ROLE_PROMPT", approve=True)
    run([npm, "install", "--global", "--no-audit", "--no-fund", "@piewf/pi-ext-roles@0.1.2"], env, cwd, "binary-handover")
    assert role.resolve() == (modules / "@piewf/pi-ext-roles/dist/cli.js").resolve()
    put(agent / "pi-ext-roles/settings.json", {"modelAliases": {"legacy-choice": "fixture/model:off"}})
    requests.clear()
    assert "verified" in run([role, "migration", "--no-session", "-p", "Inspect"], env, cwd, "migrated-native-launch").stdout
    assert "NEW_GLOBAL_ROLE_PROMPT" in json.dumps(requests)
    assert "NEW_PROJECT_ROLE_PROMPT" not in json.dumps(requests)

    fixture = modules / "upgrade-fixture/index.js"
    put(fixture.parent / "package.json", {"type": "module"})
    put(fixture.parent / "roles/contributed.md", '---\nmodel: fixture/model:off\ntools: ["!*", "read"]\ncontextFiles: []\n---\nCONTRIBUTED_ROLE_PROMPT')
    registration = 'registerWorkflowExtension({ source: import.meta.url, version: "1.0.0", headline: "Upgrade contributor", functions: {contributedRole: {description: "Contributor check", input: {type: "object"}, output: {type: "string"}, async run(input, wf) { await wf.agent("CHILD_REQUEST", {role: "contributed"}); return "verified"; }}}%s });'
    put(fixture, 'import {registerWorkflowExtension} from "pi-extensible-workflows"; export default pi => {' + registration % ', roleDirectories: ["./roles"]' + '};')
    settings = json.loads((agent / "settings.json").read_text())
    settings["extensions"] = [str(fixture)]
    put(agent / "settings.json", settings)
    rejected = run([cli, "doctor", "--json"], env, cwd, "legacy-contributor-rejected", success=False)
    assert rejected.returncode != 0 and "registerRoleContribution" in rejected.stdout + rejected.stderr
    put(fixture, 'import {registerWorkflowExtension} from "pi-extensible-workflows"; import {registerRoleContribution} from "@piewf/pi-ext-roles"; export default pi => {registerRoleContribution(pi,{owner:import.meta.url,roleDirectories:["./roles"]});' + registration % '' + '};')
    requests.clear()
    assert "verified" in run([cli, "run", "contributedRole"], env, cwd, "migrated-contributor").stdout
    assert "CONTRIBUTED_ROLE_PROMPT" in json.dumps(requests)
    bundle = base / "bundle"
    put(cwd / "package.json", {"private": True, "type": "module"})
    run([npm, "install", "--save-dev", "--no-audit", "--no-fund", "esbuild@0.28.2"], env, cwd, "bundle-build-dependency")
    run([cli, "bundle", "contributedRole", "--role", "contributed", "--output", bundle, "--name", "upgrade-check"], env, cwd, "reexport-bundle")
    # The standalone bundle finds its engine through Pi's managed npm directory.
    run([npm, "install", "--prefix", agent / "npm", "--no-audit", "--no-fund", *candidates], env, cwd, "bundle-engine-install")
    launcher = bundle / "upgrade-check"
    run([launcher, "setup", "--yes"], env, cwd, "bundle-setup")
    requests.clear()
    assert "verified" in run([launcher], env, cwd, "bundle-runtime").stdout
    assert "CONTRIBUTED_ROLE_PROMPT" in json.dumps(requests)
    for path, content in preserved.items():
        assert path.read_bytes() == content, path
    print(json.dumps({"check": "registry-to-candidate-upgrade", "from": "5.19.1", "to": version, "legacy_workflow": True, "settings_unchanged": True, "new_path_precedence": True, "project_trust": True, "binary_handover_without_force": True, "migrated_contributor_and_bundle": True}))


server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix="piewf-role-upgrade-") as directory:
        verify(pathlib.Path(directory), server)
finally:
    server.shutdown()
    server.server_close()
    thread.join()
