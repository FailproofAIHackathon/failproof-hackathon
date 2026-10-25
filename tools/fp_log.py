#!/usr/bin/env python3
"""Send one Yatra chat turn to Failproof as a custom-agent session.
Needs:  pip install failproofai-sdk   and a connected daemon (failproofai config).
Reads JSON on stdin: {"sessionId": "...", "events": [{"type": "user|bot|policy|tool|route", ...}]}"""
import json, sys
import failproofai_sdk as fp

data = json.load(sys.stdin)
ev = fp.event

def call(name, **kw):
    fn = getattr(ev, name, None)
    if not fn:
        return
    try:
        fn(**kw)
    except TypeError:
        # keep only the identifying field if this SDK version rejects extra fields
        keep = {k: v for k, v in kw.items() if k.endswith("_id") or k == "tool_name"}
        try:
            fn(**keep)
        except Exception as e:
            print(f"skip {name}: {e}", file=sys.stderr)

try:
    fp.configure(environment="yatra-demo")
except Exception:
    pass

n = 0
with fp.session():
    with fp.agent("yatra-chat"):
        for i, e in enumerate(data.get("events", [])):
            t, cid = e.get("type"), f"{data.get('sessionId','s')}-{i}"
            if t == "user":
                call("human_input", text=e.get("text", ""))
            elif t == "bot":
                call("model_response", text=e.get("text", ""))
            elif t in ("tool", "route"):
                call("tool_use", tool_name=e.get("name", "route.mjs"), tool_call_id=cid, input=e.get("text", ""))
                call("tool_result", tool_call_id=cid, status="error" if e.get("failed") else "ok", output=e.get("text", ""))
            elif t == "policy":
                call("hook_triggered", hook_id=cid, hook_name=e.get("name", "yatra-policy"), event="PreToolUse")
                call("hook_completed", hook_id=cid, outcome=e.get("decision", "allow"), reason=e.get("text", ""))
                if e.get("decision") == "deny":
                    call("error", message=f"{e.get('name')}: {e.get('text','')}"[:500])
            n += 1
fp_flush = getattr(fp, "flush", None)
if callable(fp_flush):
    try:
        fp_flush()
    except Exception:
        pass
print(f"{n} events")
