#!/usr/bin/env python3
"""Strip letters/symbols from every Canvas user's SIS id (membership number), keeping the digits.

Reads CANVAS_BASE_URL / CANVAS_ACCOUNT_ID / CANVAS_API_TOKEN from ../.env.
Includes deleted users. Dry run by default: writes sis_id_changes.csv (old -> new)
and changes nothing. Pass --apply to update Canvas.

Rows are flagged and skipped when the cleaned id is empty or would collide with
another user's id; check the "status" column in the CSV.

Usage: python3 scripts/fix_sis_ids.py [--apply]
"""
import argparse, csv, json, os, re, sys, urllib.request, urllib.parse
from pathlib import Path

def load_env():
    env = dict(os.environ)
    p = Path(__file__).resolve().parent.parent / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"\''))
    return env

def call(env, method, path, params=None, body=None):
    url = env["CANVAS_BASE_URL"].rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    out = []
    while url:
        req = urllib.request.Request(
            url, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {env['CANVAS_API_TOKEN']}",
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req) as r:
            data = json.load(r)
            link = r.headers.get("Link", "")
        out.extend(data if isinstance(data, list) else [data])
        m = re.search(r'<([^>]+)>;\s*rel="next"', link)
        url = m.group(1) if m else None
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    env = load_env()
    for k in ("CANVAS_BASE_URL", "CANVAS_ACCOUNT_ID", "CANVAS_API_TOKEN"):
        if not env.get(k) or "paste-your" in env[k]:
            sys.exit(f"Set {k} in .env")
    acct = env["CANVAS_ACCOUNT_ID"]

    users = call(env, "GET", f"/api/v1/accounts/{acct}/users",
                 {"per_page": 100, "include_deleted_users": "true"})
    print(f"{len(users)} users (including deleted)")
    taken = {}
    for u in users:
        if u.get("sis_user_id"):
            taken.setdefault(u["sis_user_id"], []).append(u["id"])

    changes = []
    for u in users:
        sis = u.get("sis_user_id")
        if not sis or sis.isdigit():
            continue
        new = re.sub(r"\D", "", sis)
        status = "ok"
        if not new:
            status = "skip: no digits"
        elif new in taken:
            status = "skip: collides with existing id"
        else:
            taken[new] = [u["id"]]
        changes.append({"canvas_user_id": u["id"], "name": u["name"], "login": u.get("login_id", ""),
                        "old_sis_id": sis, "new_sis_id": new, "status": status})
    print(f"{len(changes)} need cleaning, {sum(c['status'] != 'ok' for c in changes)} skipped")

    out = Path("sis_id_changes.csv")
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(changes[0]) if changes else ["canvas_user_id"])
        w.writeheader(); w.writerows(changes)
    print(f"wrote {out}")
    if not args.apply:
        print("dry run - re-run with --apply to update Canvas")
        return

    for c in changes:
        if c["status"] != "ok":
            continue
        try:
            logins = call(env, "GET", f"/api/v1/users/{c['canvas_user_id']}/logins")
            login = next((l for l in logins if l.get("sis_user_id") == c["old_sis_id"]), None)
            if not login:
                print(f"FAILED {c['name']}: login with that SIS id not found"); continue
            call(env, "PUT", f"/api/v1/accounts/{acct}/logins/{login['id']}",
                 body={"login": {"sis_user_id": c["new_sis_id"]}})
            print(f"{c['name']}: {c['old_sis_id']} -> {c['new_sis_id']}")
        except Exception as e:
            print(f"FAILED {c['name']}: {e}")

if __name__ == "__main__":
    main()
