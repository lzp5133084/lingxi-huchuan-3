# -*- coding: utf-8 -*-
"""
数字生态家园 · 灵犀互传 3.0 商用版 · 文件服务器缓存（VIP）
运行在 127.0.0.1:8771，由 nginx /c3/ 路径反向代理
功能：发送的文件在服务器临时缓存（默认 10 分钟），同一房间任何设备可凭链接重复下载
作者：军哥懂保（微信：xunijiayuan）
"""
import json
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

CACHE_DIR = os.environ.get("LANHUB_CACHE_DIR", "/tmp/lanhub-cache3")
DEFAULT_TTL = 600          # 10 分钟
MAX_TTL = 3600
MAX_SIZE = 512 * 1024 * 1024   # 512MB
ID_RE = re.compile(r"^[0-9a-f]{16,32}$")

os.makedirs(CACHE_DIR, exist_ok=True)


def cleanup_loop():
    while True:
        time.sleep(30)
        now = time.time()
        for fn in os.listdir(CACHE_DIR):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(CACHE_DIR, fn)
            try:
                with open(p, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                if meta.get("expires", 0) < now:
                    base = p[:-5]
                    for x in (base + ".bin", p):
                        try:
                            os.remove(x)
                        except OSError:
                            pass
            except Exception:
                pass


class Handler(BaseHTTPRequestHandler):
    server_version = "LanHubCache3/1.0"

    def log_message(self, fmt, *args):
        print("[cache3] " + (fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path not in ("/upload", "/c3/upload"):
            return self._json(404, {"ok": False, "error": "not found"})
        qs = parse_qs(u.query)
        name = unquote((qs.get("name") or ["file.bin"])[0])[:180]
        try:
            ttl = int((qs.get("ttl") or [DEFAULT_TTL])[0])
        except ValueError:
            ttl = DEFAULT_TTL
        ttl = max(60, min(ttl, MAX_TTL))
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0:
            return self._json(400, {"ok": False, "error": "空文件"})
        if size > MAX_SIZE:
            return self._json(413, {"ok": False, "error": "文件超过 512MB"})

        fid = uuid.uuid4().hex
        tmp = os.path.join(CACHE_DIR, fid + ".part")
        got = 0
        with open(tmp, "wb") as f:
            while got < size:
                chunk = self.rfile.read(min(1048576, size - got))
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
        if got != size:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return self._json(400, {"ok": False, "error": "上传中断"})

        base = os.path.join(CACHE_DIR, fid)
        os.replace(tmp, base + ".bin")
        meta = {"id": fid, "name": name, "size": size, "ttl": ttl,
                "expires": time.time() + ttl, "created": time.time()}
        with open(base + ".json", "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
        self.log_message("缓存文件 %s (%d bytes, ttl=%ds) %s", fid, size, ttl, name)
        return self._json(200, {"ok": True, "id": fid, "name": name, "size": size,
                                "ttl": ttl, "expires": meta["expires"],
                                "url": "/c3/f/" + fid})

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/health", "/c3/health"):
            n = len([x for x in os.listdir(CACHE_DIR) if x.endswith(".bin")])
            return self._json(200, {"ok": True, "files": n, "ts": time.time()})
        m = re.match(r"^/(?:c3/)?f/([0-9a-f]{16,32})$", u.path)
        if not m:
            return self._json(404, {"ok": False, "error": "not found"})
        fid = m.group(1)
        mpath = os.path.join(CACHE_DIR, fid + ".json")
        if not os.path.exists(mpath):
            return self._json(404, {"ok": False, "error": "缓存已过期或不存在"})
        with open(mpath, "r", encoding="utf-8") as f:
            meta = json.load(f)
        if meta.get("expires", 0) < time.time():
            return self._json(410, {"ok": False, "error": "缓存已过期（有效期 10 分钟）"})
        fpath = os.path.join(CACHE_DIR, fid + ".bin")
        if not os.path.exists(fpath):
            return self._json(404, {"ok": False, "error": "文件不存在"})
        qs = parse_qs(u.query)
        name = unquote((qs.get("n") or [meta.get("name") or "file.bin"])[0])[:180]
        try:
            name.encode("ascii")
            disp = 'attachment; filename="%s"' % name.replace('"', "_")
        except UnicodeEncodeError:
            from urllib.parse import quote
            disp = "attachment; filename*=UTF-8''%s" % quote(name)

        size = os.path.getsize(fpath)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", disp)
        self._cors()
        self.end_headers()
        with open(fpath, "rb") as f:
            while True:
                chunk = f.read(262144)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break


def main():
    threading.Thread(target=cleanup_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", 8771), Handler)
    print("[cache3] 文件缓存服务启动: http://127.0.0.1:8771  目录:", CACHE_DIR)
    srv.serve_forever()


if __name__ == "__main__":
    main()
