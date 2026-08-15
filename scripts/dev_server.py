#!/usr/bin/env python3
"""Local stand-in for the ESP32 HTTP API so the UI can be iterated on a desktop."""

from __future__ import annotations

import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
STATE = ROOT / ".dev-state"
STATE.mkdir(exist_ok=True)

CFG_PATH = STATE / "config.json"
INV_PATH = STATE / "inventory.json"

DEFAULT_CFG = {
    "version": 1,
    "rackName": "Bench Rack",
    "rows": 6,
    "cols": 6,
    "leds": {
        "pin": 13,
        "count": 36,
        "order": "GRB",
        "brightness": 72,
        "idleBrightness": 18,
        "locateColor": "#3DD6E0",
        "idleAnim": "breathe",
        "startupAnim": "cascade",
    },
    "wiring": {
        "origin": "top-left",
        "rowFirst": True,
        "serpentine": True,
        "offset": 0,
    },
    "overrides": {},
    "ui": {
        "locateOnSelect": True,
        "locateHoldMs": 0,
        "lowStockQty": 5,
        "remoteSearch": True,
    },
}

lock = threading.Lock()
led_mode = "idle"


def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return json.loads(json.dumps(default))


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def cell_label(row: int, col: int) -> str:
    n = col + 1
    s = ""
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return f"{s}{row + 1}"


def parse_cell(raw: str, rows: int, cols: int):
    raw = raw.strip().upper()
    i = 0
    acc = 0
    while i < len(raw) and raw[i].isalpha():
        acc = acc * 26 + (ord(raw[i]) - 64)
        i += 1
    r = int(raw[i:]) - 1
    c = acc - 1
    if 0 <= r < rows and 0 <= c < cols:
        return r, c
    raise ValueError("bad cell")


def led_for(cfg, row, col):
    key = str(row * cfg["cols"] + col)
    if key in cfg.get("overrides", {}):
        return int(cfg["overrides"][key])
    r, c = row, col
    R, C = cfg["rows"], cfg["cols"]
    origin = cfg["wiring"]["origin"]
    if origin == "top-right":
        c = C - 1 - c
    elif origin == "bottom-left":
        r = R - 1 - r
    elif origin == "bottom-right":
        r, c = R - 1 - r, C - 1 - c
    if cfg["wiring"]["rowFirst"]:
        if cfg["wiring"]["serpentine"] and r % 2:
            c = C - 1 - c
        idx = r * C + c
    else:
        if cfg["wiring"]["serpentine"] and c % 2:
            r = R - 1 - r
        idx = c * R + r
    return idx + int(cfg["wiring"]["offset"])


def fill_map(cfg):
    cfg["map"] = [
        {"row": r, "col": c, "cell": cell_label(r, c), "led": led_for(cfg, r, c)}
        for r in range(cfg["rows"])
        for c in range(cfg["cols"])
    ]
    return cfg


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DATA), **kwargs)

    def log_message(self, fmt, *args):
        print("[dev]", fmt % args)

    def _json(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/status":
            return self._json(200, {
                "ok": True, "fw": "dev", "name": "ElectronicRack",
                "ip": "127.0.0.1", "ssid": "dev", "rssi": 0, "mac": "00:00:00:00:00:00",
                "ap": False, "heap": 200000, "uptime": 0, "ledMode": 1,
                "cells": 36, "items": len(load_json(INV_PATH, {"items": []})["items"]),
            })
        if u.path == "/api/config":
            with lock:
                return self._json(200, fill_map(load_json(CFG_PATH, DEFAULT_CFG)))
        if u.path == "/api/inventory":
            return self._json(200, load_json(INV_PATH, {"version": 1, "items": []}))
        if u.path == "/api/backup":
            with lock:
                return self._json(200, {
                    "fw": "dev",
                    "config": fill_map(load_json(CFG_PATH, DEFAULT_CFG)),
                    "inventory": load_json(INV_PATH, {"version": 1, "items": []}),
                })
        if u.path == "/api/catalog/remote":
            q = parse_qs(u.query).get("q", [""])[0]
            return self._json(200, remote_search(q))
        if u.path == "/api/calibrate/walk-step":
            return self._json(200, {"active": False})
        return super().do_GET()

    def do_PUT(self):
        u = urlparse(self.path)
        body = self._body()
        if u.path == "/api/config":
            with lock:
                cfg = load_json(CFG_PATH, DEFAULT_CFG)
                deep_merge(cfg, body)
                save_json(CFG_PATH, cfg)
                return self._json(200, fill_map(cfg))
        if u.path == "/api/inventory":
            save_json(INV_PATH, body)
            return self._json(200, body)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        global led_mode
        u = urlparse(self.path)
        body = self._body()
        with lock:
            cfg = load_json(CFG_PATH, DEFAULT_CFG)
            inv = load_json(INV_PATH, {"version": 1, "items": []})

            if u.path == "/api/locate":
                print("[led] locate", body.get("cell"))
                return self._json(200, {"ok": True, "cell": body.get("cell"), "led": 0})
            if u.path == "/api/leds":
                led_mode = body.get("mode", "idle")
                print("[led] mode", led_mode, body)
                return self._json(200, {"ok": True})
            if u.path == "/api/stock/place":
                place(inv, cfg, body)
                save_json(INV_PATH, inv)
                return self._json(200, {"ok": True, "id": body.get("id") or "dev", "cell": body.get("cell"), "qty": body.get("qty", 1)})
            if u.path == "/api/stock/adjust":
                qty = adjust(inv, cfg, body.get("cell"), int(body.get("delta") or 0))
                save_json(INV_PATH, inv)
                return self._json(200, {"ok": True, "qty": qty, "cell": body.get("cell")})
            if u.path == "/api/stock/set":
                qty = set_qty(inv, cfg, body.get("cell"), int(body.get("qty") or 0))
                save_json(INV_PATH, inv)
                return self._json(200, {"ok": True, "qty": qty})
            if u.path == "/api/stock/clear":
                clear_cell(inv, cfg, body.get("cell"))
                save_json(INV_PATH, inv)
                return self._json(200, {"ok": True})
            if u.path == "/api/stock/move":
                move(inv, cfg, body.get("from"), body.get("to"))
                save_json(INV_PATH, inv)
                return self._json(200, {"ok": True})
            if u.path == "/api/restore":
                if "config" in body:
                    save_json(CFG_PATH, deep_merge(load_json(CFG_PATH, DEFAULT_CFG), body["config"]))
                if "inventory" in body:
                    save_json(INV_PATH, body["inventory"])
                return self._json(200, {"ok": True})
            if u.path == "/api/factory-reset":
                save_json(CFG_PATH, DEFAULT_CFG)
                save_json(INV_PATH, {"version": 1, "items": []})
                return self._json(200, {"ok": True})
        self._json(404, {"error": "not found"})


def find_at(inv, row, col):
    for item in inv["items"]:
        for loc in item.get("locs", []):
            if loc["row"] == row and loc["col"] == col:
                return item, loc
    return None, None


def place(inv, cfg, body):
    r, c = parse_cell(body["cell"], cfg["rows"], cfg["cols"])
    existing, loc = find_at(inv, r, c)
    if existing and existing.get("name") != body.get("name"):
        existing["locs"] = [l for l in existing["locs"] if not (l["row"] == r and l["col"] == c)]
        if not existing["locs"]:
            inv["items"] = [i for i in inv["items"] if i is not existing]
        existing = None
    if not existing:
        existing = {
            "id": body.get("id") or os.urandom(3).hex(),
            "name": body.get("name"),
            "mpn": body.get("mpn", ""),
            "sku": body.get("sku", ""),
            "category": body.get("category", "other"),
            "package": body.get("package", ""),
            "brand": body.get("brand", ""),
            "notes": body.get("notes", ""),
            "source": body.get("source", "custom"),
            "color": body.get("color", "#E6A15C"),
            "locs": [],
        }
        inv["items"].append(existing)
        loc = None
    if not loc:
        loc = {"row": r, "col": c, "cell": cell_label(r, c), "qty": 0}
        existing["locs"].append(loc)
    loc["qty"] = int(body.get("qty") or 0)
    existing["qty"] = sum(l["qty"] for l in existing["locs"])


def adjust(inv, cfg, cell, delta):
    r, c = parse_cell(cell, cfg["rows"], cfg["cols"])
    item, loc = find_at(inv, r, c)
    if not loc:
        raise ValueError("empty")
    loc["qty"] = max(0, loc["qty"] + delta)
    if loc["qty"] == 0:
        item["locs"] = [l for l in item["locs"] if l is not loc]
        if not item["locs"]:
            inv["items"] = [i for i in inv["items"] if i is not item]
    return loc["qty"] if loc["qty"] else 0


def set_qty(inv, cfg, cell, qty):
    r, c = parse_cell(cell, cfg["rows"], cfg["cols"])
    _, loc = find_at(inv, r, c)
    if not loc:
        raise ValueError("empty")
    loc["qty"] = max(0, qty)
    return loc["qty"]


def clear_cell(inv, cfg, cell):
    r, c = parse_cell(cell, cfg["rows"], cfg["cols"])
    item, loc = find_at(inv, r, c)
    if not item:
        return
    item["locs"] = [l for l in item["locs"] if l is not loc]
    if not item["locs"]:
        inv["items"] = [i for i in inv["items"] if i is not item]


def move(inv, cfg, src, dst):
    r, c = parse_cell(src, cfg["rows"], cfg["cols"])
    item, loc = find_at(inv, r, c)
    if not loc:
        raise ValueError("empty")
    tr, tc = parse_cell(dst, cfg["rows"], cfg["cols"])
    loc["row"], loc["col"], loc["cell"] = tr, tc, cell_label(tr, tc)


def remote_search(q: str):
    if not q:
        return {"q": q, "items": [], "sources": []}
    url = "https://jlcsearch.tscircuit.com/api/search?q=" + q.replace(" ", "%20") + "&limit=12"
    try:
        req = Request(url, headers={"User-Agent": "ElectronicRack-dev/1.0"})
        with urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
        items = []
        for c in data.get("components") or []:
            items.append({
                "name": c.get("mfr") or "",
                "mpn": c.get("mfr") or "",
                "package": c.get("package") or "",
                "category": "other",
                "brand": "",
                "source": "jlcsearch",
                "sku": "C" + str(c.get("lcsc", "")),
                "color": "#22D3EE",
            })
        return {"q": q, "items": items, "sources": ["jlcsearch"], "count": len(items)}
    except Exception as exc:
        return {"q": q, "items": [], "error": str(exc), "sources": []}


def main():
    if not CFG_PATH.exists():
        save_json(CFG_PATH, DEFAULT_CFG)
    if not INV_PATH.exists():
        save_json(INV_PATH, {"version": 1, "items": []})
    port = int(os.environ.get("PORT", "8080"))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"UI on http://127.0.0.1:{port}/")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
