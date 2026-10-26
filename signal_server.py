# -*- coding: utf-8 -*-
"""
数字生态家园 · 灵犀互传 3.0 商用版 WebSocket 信令服务器
运行在 127.0.0.1:8770，由 nginx /ws3 路径反向代理
功能：设备发现 + WebRTC 信令中继 + 房间房主/主播角色 + 进房公告 + 设备类型识别
作者：军哥懂保（微信：xunijiayuan）
"""
import asyncio
import json
import logging
import re
import time
import uuid

import websockets

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
log = logging.getLogger("signal3")

# 所有连接 {websocket: {"id","name","ip","room","deviceType","caps","role","last_seen"}}
clients = {}
# 按设备ID索引
clients_by_id = {}
# 房间状态 {room: {"host": id|None, "anchors": [id,...]}}
rooms = {}

HEARTBEAT_TIMEOUT = 25
HEALTH_CHECK_INTERVAL = 8

DEFAULT_ROOM = "public"
ROOM_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
DEVICE_TYPES = ("phone", "tablet", "pc", "other")


def normalize_room(raw):
    room = str(raw or "").strip()
    if not room or not ROOM_RE.match(room):
        return DEFAULT_ROOM
    return room


def room_state(room):
    st = rooms.get(room)
    if st is None:
        st = {"host": None, "anchors": [], "live": []}
        rooms[room] = st
    st.setdefault("anchors", [])
    st.setdefault("live", [])
    return st


def online(cid):
    ws = clients_by_id.get(cid) if cid else None
    return clients.get(ws) if ws else None


def name_of(cid):
    c = online(cid)
    return (c.get("name") if c else "") or "设备"


def role_of(room, cid):
    st = room_state(room)
    if st["host"] == cid:
        return "host"
    if cid in st["anchors"]:
        return "anchor"
    return ""


def roles_payload(room):
    st = room_state(room)
    return {
        "type": "room-roles",
        "room": room,
        "host": st["host"] or "",
        "hostName": name_of(st["host"]) if st["host"] else "",
        "anchors": [{"id": a, "name": name_of(a), "live": a in st["live"]}
                    for a in st["anchors"] if online(a)],
        "live": [a for a in st["live"] if online(a)],
    }


async def send_to(ws, obj):
    try:
        await ws.send(json.dumps(obj))
        return True
    except Exception:
        return False


async def broadcast_room(room, obj, exclude=None):
    """向同房间客户端广播（exclude 可排除发送者自身）"""
    raw = json.dumps(obj)
    targets = [ws for ws, c in clients.items()
               if c.get("room") == room and ws is not exclude]
    if targets:
        await asyncio.gather(*[ws.send(raw) for ws in targets], return_exceptions=True)


async def notice(room, text, kind="info"):
    """系统公告：进房/离房/主播变更，前端写入消息记录"""
    await broadcast_room(room, {"type": "system-notice", "text": text, "kind": kind, "t": time.time()})
    log.info(f"公告[{room}] {text}")


async def broadcast_devices(room=None):
    """广播设备列表：仅发给同房间的已注册客户端（带设备类型与房主/主播角色）"""
    def entry(c):
        rid = c.get("room", DEFAULT_ROOM)
        st = room_state(rid)
        return {"id": c["id"], "name": c["name"], "ip": c["ip"], "busy": c.get("busy", False),
                "caps": c.get("caps") or {}, "deviceType": c.get("deviceType", "other"),
                "role": role_of(rid, c["id"]), "live": c["id"] in st["live"]}

    devices = [entry(c) for c in clients.values()
               if c["name"] and (room is None or c.get("room") == room)]
    msg = json.dumps({"type": "peers", "list": devices, "count": len(devices),
                      "roles": roles_payload(room or DEFAULT_ROOM)})
    targets = [ws for ws, c in clients.items()
               if c["name"] and (room is None or c.get("room") == room)]
    if targets:
        await asyncio.gather(*[ws.send(msg) for ws in targets], return_exceptions=True)


def promote_host(room):
    """房主离开后，把最早进入同房间的设备提升为房主"""
    st = room_state(room)
    cand = [c for c in clients.values() if c.get("room") == room and c.get("name")]
    if not cand:
        st["host"] = None
        st["anchors"] = []
        st["live"] = []
        return None
    cand.sort(key=lambda c: c.get("connected_at", 0))
    st["host"] = cand[0]["id"]
    if st["host"] in st["anchors"]:
        st["anchors"].remove(st["host"])
    if st["host"] in st["live"]:
        st["live"].remove(st["host"])
    return cand[0]


async def on_room_changed(room, text, kind="join"):
    await broadcast_devices(room)
    await broadcast_room(room, roles_payload(room))
    await notice(room, text, kind)


async def handle(websocket):
    # 链路：客户端 → Caddy(终止TLS) → nginx → 本服务
    client_ip = "unknown"
    try:
        headers = getattr(websocket, "request_headers", None)
        if headers is None:
            req = getattr(websocket, "request", None)
            headers = getattr(req, "headers", None)
        if headers:
            xff = headers.get("X-Forwarded-For", "")
            client_ip = xff.split(",")[0].strip() if xff else headers.get("X-Real-IP", "")
        if not client_ip and websocket.remote_address:
            client_ip = websocket.remote_address[0]
        if not client_ip:
            client_ip = "unknown"
    except Exception:
        pass

    device_id = uuid.uuid4().hex[:8]
    clients[websocket] = {"id": device_id, "name": None, "ip": client_ip,
                          "room": DEFAULT_ROOM, "deviceType": "other",
                          "connected_at": time.time(), "last_seen": time.time()}
    clients_by_id[device_id] = websocket
    log.info(f"新连接: {device_id} ({client_ip})")

    await send_to(websocket, {"type": "welcome", "id": device_id})
    me = clients[websocket]

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")
            me["last_seen"] = time.time()

            if msg_type == "ping":
                await send_to(websocket, {"type": "pong", "t": time.time()})
                continue

            # ---------- 设备注册 ----------
            elif msg_type == "hello":
                name = msg.get("name", "匿名设备")
                client_did = str(msg.get("deviceId", "")).strip()
                if client_did and client_did != device_id:
                    old_ws = clients_by_id.get(client_did)
                    if old_ws and old_ws != websocket:
                        log.info(f"设备重连，替换旧连接: {name}({client_did})")
                        try:
                            await old_ws.close(code=1000, reason="device_reconnected")
                        except Exception:
                            pass
                        old_c = clients.pop(old_ws, None)
                        if old_c:
                            old_room = old_c.get("room", DEFAULT_ROOM)
                            st = room_state(old_room)
                            if old_c.get("id") in st["anchors"]:
                                st["anchors"].remove(old_c.get("id"))
                            if old_c.get("id") in st["live"]:
                                st["live"].remove(old_c.get("id"))
                            if st["host"] == old_c.get("id"):
                                promote_host(old_room)
                        clients_by_id.pop(client_did, None)
                    clients_by_id.pop(device_id, None)
                    device_id = client_did
                    clients_by_id[device_id] = websocket
                    me["id"] = device_id

                me["name"] = name
                me["room"] = normalize_room(msg.get("room"))
                caps = msg.get("caps")
                me["caps"] = caps if isinstance(caps, dict) else {}
                dt = str(msg.get("deviceType", "other"))
                me["deviceType"] = dt if dt in DEVICE_TYPES else "other"

                became_host = False
                st = room_state(me["room"])
                if not st["host"] or not online(st["host"]):
                    st["host"] = device_id
                    became_host = True
                log.info(f"设备注册: {name} ({device_id}) 房间[{me['room']}] "
                         f"类型{me['deviceType']} 能力{me['caps']} 房主{became_host}")
                await send_to(websocket, {"type": "room-joined", "room": me["room"],
                                          "id": device_id, "isHost": became_host})
                await on_room_changed(
                    me["room"],
                    f"{name} 进入房间" + ("，成为房主" if became_host else ""),
                    "join")

            # ---------- 切换房间 ----------
            elif msg_type == "join-room":
                old_room = me.get("room", DEFAULT_ROOM)
                new_room = normalize_room(msg.get("room"))
                if new_room != old_room:
                    name = me.get("name") or device_id
                    st_old = room_state(old_room)
                    if me["id"] in st_old["anchors"]:
                        st_old["anchors"].remove(me["id"])
                    if me["id"] in st_old["live"]:
                        st_old["live"].remove(me["id"])
                    if st_old["host"] == me["id"]:
                        promote_host(old_room)
                    me["room"] = new_room
                    log.info(f"设备换房: {name} [{old_room}] -> [{new_room}]")
                    await broadcast_devices(old_room)
                    await broadcast_room(old_room, roles_payload(old_room))
                    await notice(old_room, f"{name} 离开了房间", "leave")

                    st_new = room_state(new_room)
                    became_host = False
                    if not st_new["host"] or not online(st_new["host"]):
                        st_new["host"] = me["id"]
                        became_host = True
                    await send_to(websocket, {"type": "room-joined", "room": new_room,
                                              "isHost": became_host})
                    await on_room_changed(
                        new_room,
                        f"{name} 进入房间" + ("，成为房主" if became_host else ""),
                        "join")
                else:
                    await broadcast_devices(new_room)

            elif msg_type == "rename":
                new_name = str(msg.get("name", "")).strip()
                if new_name:
                    old = me["name"]
                    me["name"] = new_name
                    log.info(f"设备改名: {old} -> {new_name} ({device_id})")
                    await broadcast_devices(me.get("room"))
                    await broadcast_room(me["room"], roles_payload(me["room"]))

            elif msg_type == "busy":
                me["busy"] = bool(msg.get("busy"))
                await broadcast_devices(me.get("room"))

            elif msg_type == "caps":
                caps = msg.get("caps")
                me["caps"] = caps if isinstance(caps, dict) else {}
                await broadcast_devices(me.get("room"))

            elif msg_type == "list":
                await broadcast_devices(me.get("room"))

            # ---------- 主播模式：申请 / 审批 / 退出 ----------
            elif msg_type == "anchor-apply":
                room = me.get("room", DEFAULT_ROOM)
                st = room_state(room)
                if st["host"] == me["id"]:
                    await send_to(websocket, {"type": "sys-msg", "text": "你是房主，可直接在设备卡片上把成员设为主播"})
                elif me["id"] in st["anchors"]:
                    await send_to(websocket, {"type": "sys-msg", "text": "你已是主播"})
                elif not st["host"] or not online(st["host"]):
                    st["anchors"].append(me["id"])
                    await on_room_changed(room, f"{me['name']} 申请成为主播（当前无房主，自动通过）", "anchor")
                else:
                    host_ws = clients_by_id.get(st["host"])
                    await send_to(host_ws, {"type": "anchor-request", "from": me["id"],
                                            "fromName": me["name"]})
                    await send_to(websocket, {"type": "sys-msg", "text": "已提交主播申请，等待房主审批"})
                    log.info(f"主播申请: {me['name']} -> 房主 {st['host']}")

            elif msg_type == "anchor-answer":
                room = me.get("room", DEFAULT_ROOM)
                st = room_state(room)
                if st["host"] != me["id"]:
                    await send_to(websocket, {"type": "error", "message": "只有房主可以审批主播"})
                else:
                    target = str(msg.get("to", ""))
                    ok = bool(msg.get("ok"))
                    if online(target):
                        if ok and target not in st["anchors"]:
                            st["anchors"].append(target)
                        elif not ok and target in st["anchors"]:
                            st["anchors"].remove(target)
                            if target in st["live"]:
                                st["live"].remove(target)
                        await send_to(clients_by_id.get(target), {
                            "type": "sys-msg",
                            "text": "房主已批准你成为主播，点击「开始直播」即可开播" if ok else "房主拒绝了你的主播申请"
                        })
                        await on_room_changed(room,
                                              f"{name_of(target)} {'成为主播' if ok else '取消了主播身份'}",
                                              "anchor")

            # 房主直接在设备卡片上设置/取消主播
            elif msg_type in ("anchor-set", "anchor-unset"):
                room = me.get("room", DEFAULT_ROOM)
                st = room_state(room)
                if st["host"] != me["id"]:
                    await send_to(websocket, {"type": "sys-msg", "text": "只有房主可以设置主播"})
                    continue
                target = str(msg.get("to", ""))
                if not online(target):
                    await send_to(websocket, {"type": "sys-msg", "text": "该设备不在线"})
                    continue
                if msg_type == "anchor-set":
                    if target not in st["anchors"]:
                        st["anchors"].append(target)
                    await send_to(clients_by_id.get(target), {
                        "type": "sys-msg", "text": "房主已把你设为主播，点击「开始直播」即可开播"})
                    await on_room_changed(room, f"{name_of(target)} 成为主播", "anchor")
                else:
                    if target in st["anchors"]:
                        st["anchors"].remove(target)
                    if target in st["live"]:
                        st["live"].remove(target)
                    await send_to(clients_by_id.get(target), {
                        "type": "sys-msg", "text": "房主取消了你的主播身份"})
                    await on_room_changed(room, f"{name_of(target)} 取消了主播身份", "anchor")

            # 主播开播 / 停播
            elif msg_type == "anchor-live":
                room = me.get("room", DEFAULT_ROOM)
                st = room_state(room)
                live = bool(msg.get("live"))
                if me["id"] in st["anchors"]:
                    if live and me["id"] not in st["live"]:
                        st["live"].append(me["id"])
                    elif not live and me["id"] in st["live"]:
                        st["live"].remove(me["id"])
                    await on_room_changed(
                        room,
                        f"🎙 {me['name']} 开始直播，进入房间即可观看" if live
                        else f"🎙 {me['name']} 结束了直播",
                        "anchor")

            elif msg_type == "anchor-quit":
                room = me.get("room", DEFAULT_ROOM)
                st = room_state(room)
                if me["id"] in st["anchors"]:
                    st["anchors"].remove(me["id"])
                    if me["id"] in st["live"]:
                        st["live"].remove(me["id"])
                    await on_room_changed(room, f"{me['name']} 退出了主播", "anchor")

            # ---------- 转发（offer/answer/ice/call-request/reject/hangup/chat/
            #            file-*/rdp-* 等），仅限同房间 ----------
            elif msg.get("to"):
                target_id = msg["to"]
                target_ws = clients_by_id.get(target_id)
                target = clients.get(target_ws) if target_ws else None
                if target_ws and target and target.get("room") == me.get("room"):
                    msg["from"] = me["id"]
                    msg["fromName"] = me["name"] or "未知"
                    ok = await send_to(target_ws, msg)
                    if not ok:
                        log.warning(f"转发失败 {target_id}")
                else:
                    await send_to(websocket, {"type": "error",
                                              "message": "目标设备不在线或不在同一房间",
                                              "to": target_id})

            elif msg_type == "broadcast":
                msg["from"] = me["id"]
                msg["fromName"] = me["name"] or "匿名"
                await broadcast_room(me.get("room", DEFAULT_ROOM), msg, exclude=websocket)

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        log.error(f"处理消息异常: {e}")
    finally:
        name = me.get("name")
        room = me.get("room", DEFAULT_ROOM)
        close_code = getattr(websocket, "close_code", None)
        close_reason = getattr(websocket, "close_reason", "") or ""

        st = room_state(room)
        if me.get("id") in st["anchors"]:
            st["anchors"].remove(me["id"])
        if me.get("id") in st["live"]:
            st["live"].remove(me["id"])
        was_host = st["host"] == me.get("id")
        # 先移除本连接，再选举新房主，否则会把刚离开的设备选成房主
        clients_by_id.pop(me.get("id"), None)
        clients.pop(websocket, None)
        if was_host:
            promote_host(room)
        log.info(f"连接断开: {name or device_id} 房间[{room}] code={close_code} reason={close_reason!r}")

        if name:
            if was_host and st.get("host"):
                await notice(room, f"{name} 离开房间，{name_of(st['host'])} 成为新房主", "leave")
            else:
                await notice(room, f"{name} 离开了房间", "leave")
        await broadcast_devices(room)
        await broadcast_room(room, roles_payload(room))


async def health_check():
    """定期清理死连接：检测 ws.closed 及心跳超时（含主播/房主清理）"""
    while True:
        await asyncio.sleep(HEALTH_CHECK_INTERVAL)
        now = time.time()
        dead = []
        for ws in list(clients.keys()):
            c = clients[ws]
            if ws.closed or (now - c.get("last_seen", now) > HEARTBEAT_TIMEOUT):
                dead.append(ws)
        rooms_touched = set()
        for ws in dead:
            c = clients.pop(ws, None)
            if not c:
                continue
            rooms_touched.add(c.get("room", DEFAULT_ROOM))
            st = room_state(c.get("room", DEFAULT_ROOM))
            if c["id"] in st["anchors"]:
                st["anchors"].remove(c["id"])
            if c["id"] in st["live"]:
                st["live"].remove(c["id"])
            if st["host"] == c["id"]:
                promote_host(c.get("room", DEFAULT_ROOM))
            clients_by_id.pop(c["id"], None)
            try:
                await ws.close(code=1000, reason="heartbeat_timeout")
            except Exception:
                pass
            log.info(f"清理死连接: {c.get('name') or c['id']}")
            if c.get("name"):
                await notice(c.get("room", DEFAULT_ROOM), f"{c['name']} 离开房间（连接超时）", "leave")
        for room in rooms_touched:
            await broadcast_devices(room)
            await broadcast_room(room, roles_payload(room))


async def main():
    host = "127.0.0.1"
    port = 8770
    log.info(f"灵犀互传 3.0 信令服务器启动: ws://{host}:{port}")
    async with websockets.serve(handle, host, port, ping_interval=15, ping_timeout=8):
        asyncio.create_task(health_check())
        await asyncio.Future()


asyncio.run(main())
