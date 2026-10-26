# -*- coding: utf-8 -*-
"""
灵犀互传 3.0 商用版 · 电脑端伴侣
作用：让电脑上的「网页版灵犀互传」也能被别人远程控制。

为什么需要它？
  浏览器出于安全沙箱限制，网页标签页本身不能被别的网页模拟鼠标键盘；
  因此电脑要「被控」，需要在本机运行这个小程序：它负责把桌面画面发出去，
  并接收远端的鼠标/键盘事件，在本机真实执行。

协议（与网页端 /ws3 信令共用）：
  上线：{"type":"hello","name":...,"deviceId":...,"room":...,"deviceType":"pc","caps":{"rdp":true,...}}
  开始：收到 {"type":"rdp-start"} → 开始推画面
  画面：发送 {"type":"frame","to":控制方id,"data":"<jpeg base64>"}
  操作：收到 {"type":"rdp-input","ev":{...}} → 本机执行
  结束：收到 {"type":"rdp-close"} → 停止

依赖：websockets、Pillow、pyautogui
作者：军哥懂保（微信：xunijiayuan）
"""
import asyncio
import base64
import io
import json
import os
import socket
import sys
import time
import uuid

try:
    import websockets
except ImportError:
    print("缺少依赖 websockets，请先执行: pip install websockets pillow pyautogui")
    sys.exit(1)
try:
    from PIL import ImageGrab
except ImportError:
    print("缺少依赖 Pillow，请先执行: pip install pillow")
    sys.exit(1)

try:
    import pyautogui
    pyautogui.FAILSAFE = False
    PYAUTOGUI_OK = True
except Exception:
    PYAUTOGUI_OK = False

WS_URL = os.environ.get("LANHUB_WS", "wss://tools.ecojia.cn/ws3")
ROOM = os.environ.get("LANHUB_ROOM", "public")
NAME = os.environ.get("LANHUB_NAME") or (socket.gethostname() or "我的电脑")
FPS = float(os.environ.get("LANHUB_FPS", "7"))
MAX_W = int(os.environ.get("LANHUB_MAXW", "1600"))
QUALITY = int(os.environ.get("LANHUB_QUALITY", "55"))

STATE_DIR = os.path.dirname(os.path.abspath(__file__))
DEVICE_FILE = os.path.join(STATE_DIR, "device_id.txt")


def load_device_id():
    try:
        with open(DEVICE_FILE, "r", encoding="utf-8") as f:
            v = f.read().strip()
            if v:
                return v
    except Exception:
        pass
    v = "pc-" + uuid.uuid4().hex[:10]
    try:
        with open(DEVICE_FILE, "w", encoding="utf-8") as f:
            f.write(v)
    except Exception:
        pass
    return v


DEVICE_ID = load_device_id()

# 当前会话：控制方设备 id（只允许发起者控制，避免被别人顺手接管）
session = {"target": None, "task": None, "clients": set()}


def grab_jpeg():
    img = ImageGrab.grab(all_screens=False)
    w, h = img.size
    if w > MAX_W:
        ratio = MAX_W / float(w)
        img = img.resize((MAX_W, int(h * ratio)))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=QUALITY)
    return base64.b64encode(buf.getvalue()).decode("ascii")


async def send_json(ws, obj):
    try:
        await ws.send(json.dumps(obj))
    except Exception:
        pass


async def frame_loop(ws):
    """按 FPS 推送桌面画面，直到会话结束"""
    try:
        while session["target"]:
            target = session["target"]
            t0 = time.time()
            try:
                data = await asyncio.get_event_loop().run_in_executor(None, grab_jpeg)
            except Exception as e:
                print("抓屏失败:", e)
                await asyncio.sleep(0.5)
                continue
            await send_json(ws, {"type": "frame", "to": target, "data": data})
            cost = time.time() - t0
            await asyncio.sleep(max(0.01, 1.0 / FPS - cost))
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print("推流异常:", e)


def apply_input(ev):
    if not PYAUTOGUI_OK:
        return
    try:
        sw, sh = pyautogui.size()
        t = ev.get("type")
        x = ev.get("x")
        y = ev.get("y")
        px = int(x * sw) if x is not None else None
        py = int(y * sh) if y is not None else None
        if t == "move" and px is not None:
            pyautogui.moveTo(px, py, duration=0)
        elif t == "down" and px is not None:
            btn = ["left", "middle", "right"][ev.get("button", 0)] if ev.get("button", 0) < 3 else "left"
            pyautogui.moveTo(px, py, duration=0)
            pyautogui.mouseDown(button=btn)
        elif t == "up" and px is not None:
            btn = ["left", "middle", "right"][ev.get("button", 0)] if ev.get("button", 0) < 3 else "left"
            pyautogui.moveTo(px, py, duration=0)
            pyautogui.mouseUp(button=btn)
        elif t == "wheel":
            pyautogui.scroll(-1 if ev.get("delta", 0) > 0 else 1)
        elif t == "key":
            key = ev.get("key") or ""
            mods = [m for m, on in (("ctrl", ev.get("ctrl")), ("alt", ev.get("alt")), ("shift", ev.get("shift"))) if on]
            special = {"Enter": "enter", "Backspace": "backspace", "Escape": "esc", "Tab": "tab",
                       " ": "space", "ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right"}
            for m in mods:
                pyautogui.keyDown(m)
            try:
                if key in special:
                    pyautogui.press(special[key])
                elif len(key) == 1:
                    pyautogui.typewrite(key)
            finally:
                for m in reversed(mods):
                    pyautogui.keyUp(m)
    except Exception as e:
        print("执行输入失败:", e)


async def handle(ws):
    print(f"已连接信令服务器: {WS_URL}")
    await send_json(ws, {
        "type": "hello", "name": NAME, "deviceId": DEVICE_ID,
        "room": ROOM, "deviceType": "pc",
        "caps": {"rdp": True, "mic": True, "ver": "pc3.0"},
    })
    print(f"已在房间【{ROOM}】上线，设备名: {NAME}")
    print("提示：在网页端设备列表点这台电脑的「🖱 远程控制」即可发起连接。\n")

    async def heartbeat():
        while True:
            await asyncio.sleep(15)
            await send_json(ws, {"type": "ping"})

    hb = asyncio.create_task(heartbeat())
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("type")
            frm = msg.get("from")
            if t == "rdp-start":
                if session["target"] and session["target"] != frm:
                    await send_json(ws, {"type": "rdp-error", "to": frm, "message": "已有其他设备正在控制本机"})
                    continue
                session["target"] = frm
                if session["task"]:
                    session["task"].cancel()
                session["task"] = asyncio.create_task(frame_loop(ws))
                await send_json(ws, {"type": "started", "to": frm})
                print(f"远程控制开始：控制方 {msg.get('fromName')} ({frm})")
            elif t == "rdp-input":
                # 只有当前会话发起者可以操作
                if session["target"] and frm == session["target"]:
                    apply_input(msg.get("ev") or {})
            elif t in ("rdp-close", "peer-left", "hangup"):
                if not session["target"] or frm == session["target"]:
                    session["target"] = None
                    if session["task"]:
                        session["task"].cancel()
                        session["task"] = None
                    print("远程控制已结束")
            elif t == "error":
                print("服务端提示:", msg.get("message"))
    finally:
        hb.cancel()
        if session["task"]:
            session["task"].cancel()
        print("连接已断开")


async def main():
    print("=" * 56)
    print(" 灵犀互传 3.0 商用版 · 电脑端伴侣")
    print(" 作者：军哥懂保（微信：xunijiayuan）")
    print("=" * 56)
    print(f"信令服务器: {WS_URL}")
    print(f"房间: {ROOM}   设备名: {NAME}   设备ID: {DEVICE_ID}")
    if not PYAUTOGUI_OK:
        print("警告：未安装 pyautogui，将只能看画面、不能执行鼠标键盘操作")
        print("      安装命令: pip install pyautogui")
    delay = 2
    while True:
        try:
            async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=20,
                                          max_size=32 * 1024 * 1024) as ws:
                delay = 2
                await handle(ws)
        except KeyboardInterrupt:
            print("已退出")
            return
        except Exception as e:
            print(f"连接失败/断开: {e}，{delay} 秒后重连…")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
