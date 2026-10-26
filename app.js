/* 灵犀互传 3.0 商用版 - 前端逻辑
 * 基础：设备发现 / 摄像头预览 / 看TA摄像头 / 看TA屏幕 / 双向视频通话 / P2P文件互传 / 消息
 * 3.0 新增：摄像头+屏幕同屏共看（画中画） / 主播模式（房主审批） / 进房公告 / 设备自动识别
 *           控制手势可视化 / 手机端全屏修复 / 消息导出TXT / 文件服务器缓存10分钟 / 默认全开
 * 作者：军哥懂保 (微信: xunijiayuan)
 */
'use strict';

/* ================= 全局状态 ================= */
let ws = null;
let myId = null;
// 持久化设备 ID：同一标签页刷新后不变，服务端据此识别重连，避免多标签页互踢
let myDeviceId = localStorage.getItem('lanhub_device_id') || ('dev-' + Math.random().toString(36).slice(2, 12));
localStorage.setItem('lanhub_device_id', myDeviceId);
let myName = localStorage.getItem('lanhub_name') || ('电脑-' + Math.random().toString(36).slice(2, 6).toUpperCase());
let myRoom = 'public';           // 当前房间码（init 时从 URL/localStorage 读取）
let peerList = [];                 // 在线设备
let lastPeersRaw = [];             // 最近一次服务端下发的原始设备列表（角色变更后重绘用）
// 2.0：多连接 mesh。peerId -> conn { pc, mode, name, stream, tile, video, ctlDc, ctlOn, rot, pendIce[], micTrack, screenFromStandby }
/* 3.0：连接键 = 设备ID|模式，同一台设备可同时保留「摄像头」和「屏幕」两路，实现同屏共看 */
const conns = new Map();
const ckey = (id, mode) => id + '|' + mode;
function connOf(id, mode) { return conns.get(ckey(id, mode)); }
function connsOfPeer(id) { return [...conns.values()].filter(c => c.id === id); }
function findConnByFrom(msg) {
  if (msg.mode) return conns.get(ckey(msg.from, msg.mode));
  const list = connsOfPeer(msg.from);
  return list.length === 1 ? list[0] : (list.find(c => c.mode === 'call') || list[0] || null);
}
let focusedPeer = null;            // 当前放大的连接（null=分格模式）
let localStream = null;            // 本机摄像头流
let screenStream = null;           // 本机屏幕共享流（非待命，随连线释放）
let micStream = null;              // 本机麦克风流（屏幕共享时叠加声音用）
let standbyStream = null;          // 屏幕待命流（提前共享保持，供「看TA屏幕」秒接）
const pendingFiles = {};           // 发送中: fileId -> {file, peer, pc, dc, bar, pct, fileId}
const filePCs = {};                // 接收中: fileId -> {offer, chunks, received, pc, bar, pct}
const receivedMemFiles = [];       // 已收文件（内存记录，云端版不落盘）
let pendingIncoming = null;        // 手动应答模式下待处理的来电 {from, mode, fromName}
let pendingCtlPeer = null;         // 发起远程控制时记住连接键，画面就绪后自动开启控制层
// ---- 3.0 主播模式 / 设备识别 / 消息导出状态 ----
let roomRoles = { host: '', hostName: '', anchors: [] };
let myRole = '';                   // 'host' | 'anchor' | ''
let anchorPendingFrom = null;      // 房主侧：待审批的主播申请人
let anchorLive = false;            // 主播是否已开播
const subscribedAnchors = new Set();   // 已自动订阅的主播设备ID
const chatLines = [];              // 消息记录（导出 TXT 用）

const $ = id => document.getElementById(id);
const els = {
  connDot: $('connDot'), connText: $('connText'),
  addrBox: $('addrBox'), addrValue: $('addrValue'),
  peerCount: $('peerCount'), peerList: $('peerList'),
  myName: $('myName'), myIp: $('myIp'),
  localCamBtn: $('localCamBtn'), stopLocalBtn: $('stopLocalBtn'),
  videoPlaceholder: $('videoPlaceholder'),
  remoteGrid: $('remoteGrid'), localVideo: $('localVideo'),
  videoStatus: $('videoStatus'), hangupBtn: $('hangupBtn'),
  recScreenBtn: $('recScreenBtn'), recAudioBtn: $('recAudioBtn'),
  vipBadge: $('vipBadge'), vipBadgeText: $('vipBadgeText'),
  incomingBar: $('incomingBar'), incomingText: $('incomingText'),
  acceptBtn: $('acceptBtn'), rejectBtn: $('rejectBtn'),
  chatLog: $('chatLog'), chatInput: $('chatInput'),
  chatTarget: $('chatTarget'), chatSendBtn: $('chatSendBtn'),
  dropZone: $('dropZone'), pickFileBtn: $('pickFileBtn'), fileInput: $('fileInput'),
  fileTarget: $('fileTarget'), transferList: $('transferList'),
  recvList: $('recvList'), refreshFilesBtn: $('refreshFilesBtn'),
  progSize: $('progSize'), progTime: $('progTime'), footStats: $('footStats'),
  fileIncomingBar: $('fileIncomingBar'), fileIncomingText: $('fileIncomingText'),
  fileAcceptBtn: $('fileAcceptBtn'), fileRejectBtn: $('fileRejectBtn'),
  roomBox: $('roomBox'), roomValue: $('roomValue'), roomSwitchBtn: $('roomSwitchBtn'),
  chatCount: $('chatCount'), exportChatBtn: $('exportChatBtn'),
  myType: $('myType'), myRoleBadge: $('myRoleBadge'),
  anchorState: $('anchorState'), anchorApplyBtn: $('anchorApplyBtn'),
  anchorLiveBtn: $('anchorLiveBtn'), anchorQuitBtn: $('anchorQuitBtn'),
  anchorPending: $('anchorPending'), anchorPendingText: $('anchorPendingText'),
  anchorAllowBtn: $('anchorAllowBtn'), anchorDenyBtn: $('anchorDenyBtn'),
  anchorTip: $('anchorTip'), anchorWatchToggle: $('anchorWatchToggle'),
  glossaryModal: $('glossaryModal'),
  rdpCursor: $('rdpCursor'), rdpActions: $('rdpActions'),
};

/* ================= 工具 ================= */
function toast(text, ms) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms || 2600);
}
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= 3.0 设备类型自动识别 ================= */
const DEVICE_META = {
  phone: { icon: '📱', label: '手机' },
  tablet: { icon: '📟', label: '平板' },
  pc: { icon: '💻', label: '电脑' },
  other: { icon: '🧩', label: '其他' },
};
function detectDeviceType() {
  if (nativeBridge()) return 'phone';   // APK 目前仅安卓
  const ua = navigator.userAgent;
  const touch = (navigator.maxTouchPoints || 0) > 1;
  if (/iPad/i.test(ua)) return 'tablet';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'phone' : 'tablet';
  if (/iPhone|iPod/i.test(ua)) return 'phone';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return touch && Math.min(screen.width, screen.height) < 900 ? 'tablet' : 'pc';
  return 'other';
}
function deviceMeta(type) { return DEVICE_META[type] || DEVICE_META.other; }

/* ================= 房间码 =================
 * 房间机制：同一分享地址带 ?room=xxx 的设备互相可见、可互传；
 * 不带 room 参数默认进入 public 公共大厅。房间码仅允许字母/数字/短横线/下划线，最长32位。
 */
function normalizeRoom(raw) {
  const room = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(room) ? room : 'public';
}
function topLocation() {
  // 嵌在门户外壳 iframe 里时取外壳地址（同源），否则取自身
  try { return window.top.location; } catch { return location; }
}
function buildShareUrl(room) {
  const loc = topLocation();
  const base = loc.origin + loc.pathname;
  return room === 'public' ? base : `${base}?room=${encodeURIComponent(room)}`;
}
function syncTopUrl() {
  // 切换房间后同步外壳地址栏（不刷新页面）
  try { window.top.history.replaceState(null, '', buildShareUrl(myRoom)); }
  catch { history.replaceState(null, '', buildShareUrl(myRoom)); }
}
function updateRoomUI() {
  els.roomValue.textContent = myRoom === 'public' ? '公共大厅' : myRoom;
  els.roomBox.title = myRoom === 'public'
    ? '当前在公共大厅，所有访客可见；点击复制分享地址'
    : `当前房间: ${myRoom}（仅同房间设备可见）；点击复制分享地址`;
}
function applyRoom(newRoom) {
  if (newRoom === myRoom) return;
  myRoom = newRoom;
  localStorage.setItem('lanhub_room', myRoom);
  // 更新地址栏（不刷新页面），分享地址同步变化
  syncTopUrl();
  send({ type: 'join-room', room: myRoom });
  updateRoomUI();
  els.addrValue.textContent = buildShareUrl(myRoom);
  toast(myRoom === 'public' ? '已回到公共大厅' : `已切换到房间「${myRoom}」`);
  addChat('sys', myRoom === 'public' ? '已进入公共大厅' : `已进入房间「${myRoom}」，仅同房间设备可见`);
  historyStore.add('切换房间', myRoom === 'public' ? '公共大厅' : myRoom);
}
/* 房间切换弹窗 */
const roomModal = $('roomModal'), roomInput = $('roomInput');
function switchRoom() {
  roomInput.value = myRoom === 'public' ? '' : myRoom;
  roomModal.classList.remove('hidden');
  setTimeout(() => roomInput.focus(), 50);
}
function closeRoomModal() { roomModal.classList.add('hidden'); }
$('roomConfirmBtn').onclick = () => { applyRoom(normalizeRoom(roomInput.value)); closeRoomModal(); };
$('roomPublicBtn').onclick = () => { applyRoom('public'); closeRoomModal(); };
$('roomCancelBtn').onclick = closeRoomModal;
roomInput.onkeydown = e => { if (e.key === 'Enter') $('roomConfirmBtn').click(); if (e.key === 'Escape') closeRoomModal(); };
roomModal.onclick = e => { if (e.target === roomModal) closeRoomModal(); };

/* ================= 历史记录（localStorage 记忆） ================= */
const historyStore = {
  key: 'lanhub_history',
  all() { try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; } },
  add(action, detail) {
    const arr = this.all();
    arr.unshift({ action, detail, time: Date.now() });
    if (arr.length > 200) arr.length = 200;
    localStorage.setItem(this.key, JSON.stringify(arr));
    renderFootStats();
  }
};
function renderFootStats() {
  const arr = historyStore.all();
  els.footStats.textContent = `历史操作: ${arr.length} 条`;
  els.footStats.title = arr.slice(0, 10).map(h => `${fmtTime(h.time)} ${h.action} ${h.detail}`).join('\n') || '暂无记录';
}

/* ================= 程序信息（大小/保存时间） ================= */
async function loadProgramInfo() {
  try {
    // 通过 fetch 自身页面获取 Last-Modified 与大小
    const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
    const lm = res.headers.get('Last-Modified');
    const len = res.headers.get('Content-Length');
    els.progTime.textContent = '上次保存: ' + (lm ? fmtTime(new Date(lm).getTime()) : '--');
    // 估算整个程序大小：HTML+CSS+JS
    let total = parseInt(len || '0', 10) || 0;
    for (const f of ['style.css', 'app.js']) {
      const r = await fetch(f, { method: 'HEAD', cache: 'no-store' });
      total += parseInt(r.headers.get('Content-Length') || '0', 10) || 0;
    }
    els.progSize.textContent = '程序大小: ' + fmtSize(total);
  } catch { /* 忽略 */ }
}

/* ================= WebSocket 连接 ================= */
let wsEverConnected = false;
let heartbeatTimer = null;
let reconnectDelay = 1000;  // 重连退避起始值
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === 1) send({ type: 'ping' });
  }, 10000);  // 每 10 秒发一次心跳，服务端 25 秒无消息则踢下线
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}
function connect() {
  // GitHub Pages 镜像页没有后端，统一走 ecojia 服务器；本站部署则用同源 /ws3
  const mirror = /\.github\.io$/i.test(location.hostname);
  const proto = mirror || location.protocol === 'https:' ? 'wss' : 'ws';
  const host = mirror ? 'tools.ecojia.cn' : location.host;
  ws = new WebSocket(`${proto}://${host}/ws3`);

  // hello 携带设备能力（2.0：APK 上报可被远程控制等能力，供对端展示「远程控制」入口）
  ws.onopen = () => {
    els.connDot.classList.add('on');
    els.connText.textContent = '已连接';
    ws.send(JSON.stringify({ type: 'hello', name: myName, room: myRoom, deviceId: myDeviceId,
      deviceType: detectDeviceType(), caps: myCaps() }));
    if (wsEverConnected) addChat('sys', '已重新连接到服务器');
    wsEverConnected = true;
    reconnectDelay = 1000;  // 连接成功，重置退避
    startHeartbeat();
  };
  ws.onclose = e => {
    els.connDot.classList.remove('on');
    stopHeartbeat();
    // 同一设备的新连接已替换本连接（如多标签页同开），不自动重连，避免互踢死循环
    if (e.reason === 'device_reconnected') {
      els.connText.textContent = '已在其他标签页连接，刷新页面可恢复';
      return;
    }
    els.connText.textContent = '已断开，重连中…';
    closeAllConns('连接断开');
    abortAllTransfers('连接中断');
    // 指数退避重连，最大 10 秒，避免服务器压力
    const delay = Math.min(reconnectDelay, 10000);
    setTimeout(connect, delay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  };
  ws.onerror = e => {
    // WebSocket 错误（多数情况下 onclose 会紧接着触发）
    console.warn('[灵犀互传] WebSocket 错误', e);
  };
  ws.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleSignal(msg);
  };
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function handleSignal(msg) {
  switch (msg.type) {
    case 'welcome': myId = msg.id; break;
    case 'pong': break;  // 心跳响应，无需处理
    case 'room-joined':
      // 服务器确认房间（可能因非法字符被规范化为 public）和设备 ID
      if (msg.id) myId = msg.id;
      if (msg.room && msg.room !== myRoom) {
        myRoom = msg.room;
        localStorage.setItem('lanhub_room', myRoom);
        syncTopUrl();
        els.addrValue.textContent = buildShareUrl(myRoom);
      }
      updateRoomUI();
      break;
    case 'peers':
      renderPeers(msg.list);
      if (msg.roles) applyRoles(msg.roles);
      break;
    case 'room-roles': applyRoles(msg); break;
    case 'system-notice':   // 3.0：进房/离房/主播变更公告写进消息记录
      addChat('sys', msg.text);
      historyStore.add('房间公告', msg.text);
      break;
    case 'sys-msg':
      addChat('sys', msg.text || '');
      toast(msg.text || '', 3600);
      break;
    case 'anchor-request': onAnchorRequest(msg); break;
    case 'peer-left':
      if (connsOfPeer(msg.id).length) {
        closePeerConns(msg.id, '对方已离开', false);
        toast(`${msg.name} 已离开`);
      }
      subscribedAnchors.delete(msg.id);
      if (!connsOfPeer(msg.id).length) { updateCallUI(); if (!conns.size && !localStream) els.videoPlaceholder.classList.remove('hidden'); }
      if (pendingCtlPeer && pendingCtlPeer.indexOf(msg.id + '|') === 0) pendingCtlPeer = null;
      break;
    case 'call-request': onIncomingCall(msg); break;
    case 'offer': onOffer(msg); break;
    case 'answer': onAnswer(msg); break;
    case 'ice': onIce(msg); break;
    case 'reject': {
      const reasonMap = { busy: '对方正在通话中', 'no-camera': '对方摄像头不可用', 'no-screen': '对方取消了屏幕共享', dup: '对方已有连线' };
      toast(reasonMap[msg.reason] || `${msg.fromName || '对方'} 拒绝了请求`);
      const c = findConnByFrom(msg);
      if (c) closeConn(c, '对方拒绝', false);
      else { updateCallUI(); if (!conns.size && !localStream) els.videoPlaceholder.classList.remove('hidden'); }
      if (pendingCtlPeer && pendingCtlPeer.indexOf(msg.from + '|') === 0) pendingCtlPeer = null;
      break;
    }
    case 'hangup': {
      const c = findConnByFrom(msg);
      toast(`${msg.fromName || '对方'} 已挂断`);
      if (c) closeConn(c, '对方挂断', false);
      break;
    }
    case 'chat': {
      const text = String(msg.text || '');
      const m = text.match(/(https?:\/\/\S+\/c3\/f\/[0-9a-f]+(?:\?\S*)?)/);
      addChat('other', `${msg.fromName}: ${m ? text.replace(m[1], '') : text}`, m ? m[1] : null);
      historyStore.add('收到消息', `来自 ${msg.fromName}`);
      break;
    }
    case 'file-offer': onFileOffer(msg); break;
    case 'file-accept': onFileAccept(msg); break;
    case 'file-reject': onFileReject(msg); break;
    case 'file-signal': onFileSignal(msg); break;
    case 'started':
      rdpSetStatus('已连接，等待画面…');
      break;
    case 'frame':
      rdpOnFrame(msg.data);
      break;
    case 'rdp-error':
      toast(msg.message || '远程桌面连接失败');
      addChat('sys', '远程桌面: ' + (msg.message || '连接失败'));
      closeRdpUI();
      break;
    case 'rdp-closed':
      if (rdpActive) { toast('远程桌面已断开'); closeRdpUI(); }
      break;
  }
}

/* ================= 远程桌面（观看 + 控制） ================= */
let rdpActive = false;
let rdpTargetId = null;
let rdpFrameCount = 0;
let rdpFpsTimer = null;
let rdpLastTs = 0;
let lastMoveSent = 0;

const rdpEls = {
  modal: document.getElementById('rdpModal'),
  title: document.getElementById('rdpTitle'),
  fps: document.getElementById('rdpFps'),
  dot: document.querySelector('.rdp-dot'),
  loading: document.getElementById('rdpLoading'),
  screen: document.getElementById('rdpScreen'),
  body: document.getElementById('rdpBody'),
  closeBtn: document.getElementById('rdpCloseBtn'),
};

/* 3.0 控制可视化：光标 + 点击涟漪 + 动作提示（鼠标移动/点击/滑动/键盘都醒目提示） */
function showControlMark(hostEl, x, y, text, kind) {
  if (!hostEl) return;
  const r = hostEl.getBoundingClientRect();
  let cur = hostEl.querySelector('.ctl-cursor');
  if (!cur) {
    cur = document.createElement('div');
    cur.className = 'ctl-cursor';
    hostEl.appendChild(cur);
  }
  const lx = x - r.left, ly = y - r.top;
  cur.style.left = lx + 'px';
  cur.style.top = ly + 'px';
  cur.classList.add('on');
  if (kind === 'tap' || kind === 'key' || kind === 'swipe') {
    const rip = document.createElement('div');
    rip.className = 'ctl-ripple';
    rip.style.left = lx + 'px';
    rip.style.top = ly + 'px';
    hostEl.appendChild(rip);
    setTimeout(() => rip.remove(), 720);
  }
  if (text) {
    let box = hostEl.querySelector('.ctl-actions');
    if (!box) {
      box = document.createElement('div');
      box.className = 'ctl-actions';
      hostEl.appendChild(box);
    }
    const line = document.createElement('div');
    line.className = 'ctl-action';
    line.textContent = text;
    box.appendChild(line);
    setTimeout(() => line.classList.add('out'), 1500);
    setTimeout(() => { try { line.remove(); } catch { /* 忽略 */ } }, 2200);
    while (box.children.length > 3) box.firstChild.remove();
  }
}

window.openRdp = peerId => {
  const peer = peerList.find(p => p.id === peerId);
  if (!peer) return;
  if (!(peer.caps && peer.caps.rdp)) {
    toast(`「${peer.name}」是浏览器页面，受安全限制无法被直接控制；请在该电脑运行「电脑端伴侣」，或改用「◘ 看TA屏幕」`, 6000);
    addChat('sys', `「${peer.name}」未安装电脑端伴侣：浏览器页面不能被远程控制；可让它运行电脑端伴侣（右上角下载），或改用「看TA屏幕」`);
    return;
  }
  if (!vipGate('远程控制')) return;
  if (rdpActive) closeRdpUI();
  rdpActive = true;
  rdpTargetId = peerId;
  rdpFrameCount = 0;
  rdpLastTs = Date.now();
  rdpEls.title.textContent = '远程桌面 · ' + peer.name;
  rdpEls.modal.classList.remove('hidden');
  rdpEls.loading.classList.remove('hidden');
  rdpEls.dot.classList.remove('live');
  rdpEls.screen.src = '';
  rdpEls.fps.textContent = '';
  send({ type: 'rdp-start', to: peerId });
  if (rdpFpsTimer) clearInterval(rdpFpsTimer);
  rdpFpsTimer = setInterval(() => {
    if (!rdpActive) return;
    rdpEls.fps.textContent = `画面 ${rdpFrameCount} 帧/秒`;
    rdpFrameCount = 0;
  }, 1000);
  toast('正在连接电脑端伴侣…鼠标点击/拖动即操作对方电脑', 3600);
  historyStore.add('远程桌面', `连接 ${peer.name}`);
};

function rdpSetStatus(text) {
  rdpEls.loading.querySelector('p').textContent = text;
}

function rdpOnFrame(data) {
  if (!rdpActive) return;
  if (!rdpEls.loading.classList.contains('hidden')) {
    rdpEls.loading.classList.add('hidden');
    rdpEls.dot.classList.add('live');
  }
  rdpEls.screen.src = 'data:image/jpeg;base64,' + data;
  rdpFrameCount++;
}

function closeRdpUI() {
  rdpActive = false;
  rdpTargetId = null;
  if (rdpFpsTimer) { clearInterval(rdpFpsTimer); rdpFpsTimer = null; }
  rdpEls.modal.classList.add('hidden');
  rdpEls.screen.src = '';
}

rdpEls.closeBtn.onclick = () => {
  send({ type: 'rdp-close' });
  closeRdpUI();
  historyStore.add('远程桌面', '断开连接');
};

// ---- 控制事件采集（归一化坐标发送） ----
function rdpPos(e) {
  const r = rdpEls.screen.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
  };
}
function rdpSend(ev) {
  if (!rdpActive || !rdpTargetId) return;
  send({ type: 'rdp-input', to: rdpTargetId, ev });
}

rdpEls.body.addEventListener('mousemove', e => {
  showControlMark(rdpEls.body, e.clientX, e.clientY, null);
  const now = Date.now();
  if (now - lastMoveSent < 40) return; // 25次/秒 节流
  lastMoveSent = now;
  const p = rdpPos(e);
  rdpSend({ type: 'move', x: p.x, y: p.y });
});
rdpEls.body.addEventListener('mousedown', e => {
  e.preventDefault();
  const p = rdpPos(e);
  const btn = ['左键', '中键', '右键'][e.button] || '按键';
  showControlMark(rdpEls.body, e.clientX, e.clientY, `鼠标按下 · ${btn}`, 'tap');
  rdpSend({ type: 'down', button: e.button, x: p.x, y: p.y });
});
rdpEls.body.addEventListener('mouseup', e => {
  const p = rdpPos(e);
  rdpSend({ type: 'up', button: e.button, x: p.x, y: p.y });
});
rdpEls.body.addEventListener('wheel', e => {
  e.preventDefault();
  showControlMark(rdpEls.body, e.clientX, e.clientY, e.deltaY > 0 ? '滚轮向下 ↓' : '滚轮向上 ↑', 'swipe');
  rdpSend({ type: 'wheel', delta: e.deltaY });
}, { passive: false });
rdpEls.body.addEventListener('contextmenu', e => e.preventDefault());

// 键盘：会话激活时全局接管（并高亮提示按键）
document.addEventListener('keydown', e => {
  if (!rdpActive) return;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  e.preventDefault();
  const label = e.key === ' ' ? '空格' : e.key;
  const r = rdpEls.body.getBoundingClientRect();
  showControlMark(rdpEls.body, r.left + r.width / 2, r.top + 40, `键盘 · ${label}`, 'key');
  rdpSend({ type: 'key', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
});

/* ================= 设备列表（3.0：设备类型 + 房主/主播角色） ================= */
function renderPeers(list) {
  lastPeersRaw = list;
  const others = list.filter(p => p.id !== myId);
  peerList = others;
  els.peerCount.textContent = others.length;

  // 更新下拉框
  const opts = '<option value="">选择设备…</option>' +
    others.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  const oldChat = els.chatTarget.value, oldFile = els.fileTarget.value;
  els.chatTarget.innerHTML = opts; els.fileTarget.innerHTML = opts;
  els.chatTarget.value = oldChat; els.fileTarget.value = oldFile;

  if (!others.length) {
    els.peerList.innerHTML = '<li class="empty-tip">当前房间暂无其他设备…<br><small>其他设备打开分享地址（相同房间码）即可互见</small></li>';
    return;
  }
  els.peerList.innerHTML = others.map(p => {
    const dm = deviceMeta(p.deviceType);
    const isAnchor = p.role === 'anchor';
    const isHost = p.role === 'host';
    const roleChip = isHost ? '<span class="role-chip host">👑 房主</span>'
      : isAnchor ? '<span class="role-chip anchor">🎙 主播</span>' : '';
    const ctl = !!(p.caps && p.caps.ctl);
    const rdp = !!(p.caps && p.caps.rdp);
    const anchorBtn = myRole === 'host'
      ? `<button class="btn ghost" onclick="toggleAnchor('${p.id}', ${isAnchor ? 'false' : 'true'})" title="房主权限：设置/取消对方的主播身份">${isAnchor ? '取消主播' : '设为主播'}</button>`
      : '';
    return `
    <li class="peer-item">
      <div class="peer-name"><span class="dev-ico">${dm.icon}</span><span class="st ${p.busy ? 'busy' : ''}"></span>${escapeHtml(p.name)}${roleChip}${p.busy ? ' <small style="color:var(--warm)">连线中</small>' : ''}</div>
      <div class="peer-ip">${dm.label} · ${escapeHtml(p.ip)}${ctl ? ' <small style="color:var(--accent2)">· 手机可被控</small>' : ''}${rdp ? ' <small style="color:var(--accent2)">· 电脑可被控</small>' : ''}</div>
      <div class="peer-actions">
        <button class="btn ghost" onclick="startView('${p.id}')" title="看对方摄像头">◉ 看看TA</button>
        <button class="btn ghost" onclick="startViewScreen('${p.id}')" title="看对方屏幕">◘ 看TA屏幕</button>
        <button class="btn primary" onclick="startCall('${p.id}')" title="双向视频通话">◈ 视频通话</button>
        ${rdp
          ? `<button class="btn ghost" onclick="openRdp('${p.id}')" title="通过电脑端伴侣远程控制这台电脑（鼠标+键盘）">🖱 远程控制</button>`
          : ctl
            ? `<button class="btn ghost" onclick="startCtl('${p.id}')" title="手机被控：需对方开启「允许远程控制」和系统无障碍服务">🖱 远程控制</button>`
            : `<button class="btn ghost" onclick="toast('对方设备不支持被控：手机需安装 APK 3.0 并开启无障碍服务；电脑需运行电脑端伴侣', 4600)" title="不支持被控">🖱 远程控制</button>`}
        ${anchorBtn}
      </div>
    </li>`;
  }).join('');
  scheduleAnchorSubscribe();
}

/* ================= 本机摄像头 ================= */
async function getCamera() {
  if (localStream) return localStream;
  // 特性检测：部分老旧浏览器或非 HTTPS 环境无 mediaDevices
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    toast('当前环境不支持摄像头，请使用 HTTPS 下的 Chrome/Edge/Safari 浏览器', 5000);
    throw new Error('getUserMedia not supported');
  }
  // 优先尝试视频+音频；若音频导致失败（部分设备麦克风授权问题），回退到纯视频
  const tryGet = async (constraints) => {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // 仅当音频失败且未授权音频时，尝试纯视频
      if (constraints.audio && (err.name === 'NotAllowedError' || err.name === 'NotFoundError' || err.name === 'NotReadableError')) {
        const videoOnly = { ...constraints };
        delete videoOnly.audio;
        const stream = await navigator.mediaDevices.getUserMedia(videoOnly);
        toast('已启用摄像头（麦克风不可用，仅画面）');
        return stream;
      }
      throw err;
    }
  };
  try {
    localStream = await tryGet({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: true
    });
    return localStream;
  } catch (err) {
    if (err.name === 'NotAllowedError') toast('摄像头权限被拒绝，请在浏览器地址栏点击锁图标 → 允许摄像头/麦克风');
    else if (err.name === 'NotFoundError') toast('未检测到摄像头设备，请确认设备已连接');
    else if (err.name === 'NotReadableError') toast('摄像头被其他程序占用，请关闭后重试');
    else if (err.name === 'SecurityError') toast('摄像头需要 HTTPS 环境才能使用');
    else toast('摄像头打开失败: ' + (err.message || err.name));
    throw err;
  }
}

/* ================= 原生壳（APK）屏幕共享通道 =================
 * 华为鸿蒙等机型浏览器不开放 getDisplayMedia，但原生 App 能直接调系统 MediaProjection。
 * 装「灵犀互传」APK 后，页面经原生桥取到屏幕画面，用 canvas.captureStream 转成标准
 * MediaStream，后续 WebRTC 链路完全沿用，网页逻辑无需改动。
 */
let nativeCapture = null;   // { canvas, ctx, stream, track, timer, stopped }

function nativeBridge() {
  if (window.LanHubNative && window.LanHubNative.available) return window.LanHubNative;
  try {
    const t = window.top;
    if (t && t.LanHubNative && t.LanHubNative.available) return t.LanHubNative;
  } catch (e) { /* 跨域时忽略 */ }
  return null;
}

function waitNativeState(nb, want, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let st = 'idle';
      try { st = nb.state(); } catch (e) { /* 忽略 */ }
      if (want.indexOf(st) >= 0) return resolve(st);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待屏幕授权超时'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

function waitNativePort(nb, timeoutMs) {
  const t0 = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      let p = 0;
      try { p = nb.portNow() | 0; } catch (e) { /* 忽略 */ }
      if (p > 0) return resolve(p);
      if (Date.now() - t0 > timeoutMs) return resolve(0);
      setTimeout(tick, 200);
    };
    tick();
  });
}

function stopNativeCapture(notifyNative) {
  const nc = nativeCapture;
  if (!nc) return;
  nativeCapture = null;               // 先置空，避免 onended 递归回调
  nc.stopped = true;
  clearInterval(nc.timer);
  try {
    nc.track.onended = null;
    nc.track.stop();
  } catch (e) { /* 忽略 */ }
  try { nc.canvas.remove(); } catch (e) { /* 忽略 */ }
  if (notifyNative) {
    const nb = nativeBridge();
    if (nb) { try { nb.stopCapture(); } catch (e) { /* 忽略 */ } }
  }
}

/** 由原生帧源生成 MediaStream（10fps 画布管道；本地 HTTP 优先、JS 桥兜底） */
async function getNativeScreen() {
  const nb = nativeBridge();
  if (!nb) throw new Error('原生桥不可用');
  if (nativeCapture) stopNativeCapture(false);

  let st = 'idle';
  try { st = nb.state(); } catch (e) { /* 忽略 */ }
  if (st === 'requesting') {
    st = await waitNativeState(nb, ['active', 'denied', 'error'], 60000);
  } else if (st !== 'active') {
    nb.startCapture();   // 唤起系统「开始录制或投放」授权弹窗
    st = await waitNativeState(nb, ['active', 'denied', 'error'], 60000);
  }
  if (st !== 'active') {
    throw new Error(st === 'denied' ? '你取消了屏幕授权' : '屏幕采集启动失败');
  }

  const port = await waitNativePort(nb, 4000);
  if (!port) throw new Error('原生帧服务未就绪');

  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1280;
  canvas.style.cssText = 'position:fixed;left:-4px;top:-4px;width:1px;height:1px;opacity:.01;pointer-events:none;z-index:-1';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  const stream = canvas.captureStream(10);
  const track = stream.getVideoTracks()[0];

  const nc = { canvas, ctx, stream, track, timer: 0, stopped: false };
  nativeCapture = nc;

  let useHttp = true;
  const drawFrame = async () => {
    if (nc.stopped) return;
    if (track.readyState !== 'live') { stopNativeCapture(false); return; }
    try {
      if (useHttp) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/frame?t=${Date.now()}`, { cache: 'no-store' });
          if (!res.ok) throw new Error('http ' + res.status);
          const blob = await res.blob();
          if (blob.size < 200) throw new Error('no frame');
          const bmp = await createImageBitmap(blob);
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          if (bmp.close) bmp.close();
          return;
        } catch (e) {
          useHttp = false;   // 本地 HTTP 被拦截时自动回退到 JS 桥取帧
        }
      }
      const b64 = nb.frameBase64();
      if (!b64) return;
      const img = new Image();
      await new Promise((ok, no) => {
        img.onload = ok;
        img.onerror = no;
        img.src = 'data:image/jpeg;base64,' + b64;
      });
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      ctx.drawImage(img, 0, 0);
    } catch (e) { /* 单帧失败不影响后续 */ }
  };

  nc.timer = setInterval(drawFrame, 100);
  drawFrame();
  return stream;
}

/* ================= 本机麦克风（2.0 声音：屏幕共享时叠加人声） ================= */
async function getMic() {
  if (micStream && micStream.getAudioTracks().some(t => t.readyState === 'live')) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true }, video: false
  });
  micStream.getAudioTracks().forEach(t => { t.enabled = soundOn; });
  return micStream;
}

/* ================= 本机屏幕共享 ================= */
async function getScreen() {
  const wantAudio = vipActive() && soundOn;   // VIP：尝试携带系统/扬声器声音
  if (nativeBridge()) {
    const s = await getNativeScreen();
    s.getVideoTracks()[0].onended = () => {
      stopNativeCapture(true);
      toast('屏幕共享已停止');
      if (screenStream === s) screenStream = null;
      for (const c of [...conns.values()]) if (c.mode === 'screen') closeConn(c.id, '屏幕共享已停止');
      updateCallUI();
    };
    toast('屏幕共享已开启（原生通道）');
    return s;
  }
  if (!canShareScreen()) {
    toast(screenUnsupportedTip(), 6000);
    throw new Error('getDisplayMedia not supported');
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } },
      audio: wantAudio
    });
    stream.getAudioTracks().forEach(t => { t.enabled = soundOn; });
    // 用户点浏览器"停止共享"按钮时自动结束相关连线
    stream.getVideoTracks()[0].onended = () => {
      toast('屏幕共享已停止');
      if (screenStream === stream) screenStream = null;
      for (const c of [...conns.values()]) if (c.mode === 'screen') closeConn(c.id, '屏幕共享已停止');
      updateCallUI();
    };
    return stream;
  } catch (err) {
    if (err.name === 'NotAllowedError') toast('需要在弹窗中选择一个屏幕或窗口才能共享');
    else toast('屏幕共享失败: ' + (err.message || err.name));
    throw err;
  }
}

// 本机预览（不占线，不入通话状态）
els.localCamBtn.onclick = async () => {
  try {
    const stream = await getCamera();
    els.localVideo.srcObject = stream;
    els.localVideo.classList.remove('hidden');
    els.localVideo.classList.add('full');
    els.videoPlaceholder.classList.add('hidden');
    els.videoStatus.textContent = '本机预览中';
    els.localCamBtn.classList.add('hidden');
    els.stopLocalBtn.classList.remove('hidden');
    historyStore.add('本机预览', '打开摄像头');
  } catch { /* 已提示 */ }
};
els.stopLocalBtn.onclick = () => {
  stopCamera();
  els.localVideo.classList.add('hidden');
  els.localVideo.classList.remove('full');
  if (!conns.size) {
    els.videoPlaceholder.classList.remove('hidden');
    els.videoStatus.textContent = '';
  }
  els.localCamBtn.classList.remove('hidden');
  els.stopLocalBtn.classList.add('hidden');
  historyStore.add('本机预览', '关闭摄像头');
};
function stopCamera() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
}

/* ================= 本机设置开关（自用强制接通） ================= */
let autoAnswer = localStorage.getItem('lanhub_autoanswer') !== '0';    // 默认开
let autoAcceptFiles = localStorage.getItem('lanhub_autofile') !== '0'; // 默认开

$('autoAnswerToggle').checked = autoAnswer;
$('autoFileToggle').checked = autoAcceptFiles;
$('autoAnswerToggle').onchange = e => {
  autoAnswer = e.target.checked;
  localStorage.setItem('lanhub_autoanswer', autoAnswer ? '1' : '0');
  toast(autoAnswer ? '自动应答已开启：呼叫将直接接通' : '自动应答已关闭：收到呼叫需手动接受');
  historyStore.add('设置', '自动应答 ' + (autoAnswer ? '开' : '关'));
};
$('autoFileToggle').onchange = e => {
  autoAcceptFiles = e.target.checked;
  localStorage.setItem('lanhub_autofile', autoAcceptFiles ? '1' : '0');
  toast(autoAcceptFiles ? '自动收文件已开启' : '自动收文件已关闭：收到文件将弹窗询问');
  historyStore.add('设置', '自动收文件 ' + (autoAcceptFiles ? '开' : '关'));
};

/* ================= VIP 会员（激活门） ================= */
const VIP_CODES = ['VIP2026', '18180309010'];   // 激活码 / 管理员手机号
let vip = localStorage.getItem('lanhub_vip') === '1';
function vipActive() { return vip; }
function vipGate(feat) {
  if (vip) return true;
  openVipModal(feat);
  return false;
}
const vipModal = $('vipModal'), vipInput = $('vipInput');
function openVipModal(feat) {
  vipModal.classList.remove('hidden');
  if (feat) toast(`「${feat}」为 VIP 会员功能，请先激活`, 3200);
  setTimeout(() => vipInput.focus(), 50);
}
function closeVipModal() { vipModal.classList.add('hidden'); }
function renderVipBadge() {
  els.vipBadge.classList.toggle('on', vip);
  els.vipBadgeText.textContent = vip ? 'VIP已激活' : '激活VIP';
}
els.vipBadge.onclick = () => {
  if (vip) toast('已是 VIP 会员：远程声音 / 远程控制 / 多人连线 / 录屏录音 / 全屏横竖 全部可用', 3600);
  else openVipModal();
};
$('vipConfirmBtn').onclick = () => {
  const code = vipInput.value.trim();
  if (VIP_CODES.includes(code)) {
    vip = true; localStorage.setItem('lanhub_vip', '1');
    renderVipBadge(); closeVipModal();
    toast('🎉 VIP 激活成功，全部高级功能已解锁');
    addChat('sys', 'VIP 会员已激活，2.0 高级功能全部解锁');
    historyStore.add('激活VIP', '成功');
  } else {
    toast('激活码无效，请联系作者军哥懂保（微信 xunijiayuan）获取', 4000);
  }
};
$('vipCancelBtn').onclick = closeVipModal;
vipInput.onkeydown = e => { if (e.key === 'Enter') $('vipConfirmBtn').click(); if (e.key === 'Escape') closeVipModal(); };
vipModal.onclick = e => { if (e.target === vipModal) closeVipModal(); };

// 设备能力上报（APK：可控+原生声道；电脑端伴侣：rdp 远程桌面；纯网页：均不支持被控）
function myCaps() {
  const nb = nativeBridge();
  const isCompanion = /LanHubCompanion/i.test(navigator.userAgent);
  const caps = { ctl: false, rdp: isCompanion, mic: true, ver: isCompanion ? 'pc3.0' : 'web3.0' };
  if (nb) {
    try {
      if (typeof nb.caps === 'function') Object.assign(caps, JSON.parse(nb.caps()));
      if (typeof nb.control === 'function') caps.ctl = true;
      caps.ver = 'apk3.0';
    } catch { /* 忽略 */ }
  }
  return caps;
}

/* ================= 声音开关（VIP，默认开启） ================= */
let soundOn = localStorage.getItem('lanhub_sound') !== '0';
$('soundToggle').checked = soundOn;
$('soundToggle').onchange = e => {
  if (e.target.checked && !vipGate('远程声音')) { e.target.checked = false; return; }
  soundOn = e.target.checked;
  localStorage.setItem('lanhub_sound', soundOn ? '1' : '0');
  applySoundOn();
  toast(soundOn ? '声音已开启：对方可听到你的麦克风和系统声音' : '声音已关闭：对方只能看到画面');
  historyStore.add('设置', '声音 ' + (soundOn ? '开' : '关'));
};
function applySoundOn() {
  for (const st of [localStream, screenStream, standbyStream, micStream]) {
    if (st) st.getAudioTracks().forEach(t => { t.enabled = soundOn; });
  }
}

/* ================= 允许远程控制（VIP，被控总开关） ================= */
let allowCtl = localStorage.getItem('lanhub_allowctl') !== '0';   // 3.0 默认开启
$('allowCtlToggle').checked = allowCtl;
$('allowCtlToggle').onchange = e => {
  if (e.target.checked && !vipGate('远程控制')) { e.target.checked = false; return; }
  allowCtl = e.target.checked;
  localStorage.setItem('lanhub_allowctl', allowCtl ? '1' : '0');
  const nb = nativeBridge();
  if (allowCtl && nb && typeof nb.a11yEnabled === 'function' && !nb.a11yEnabled()) {
    toast('需为本应用开启无障碍服务才能被远程控制，即将跳转系统设置…', 4200);
    setTimeout(() => { try { nb.openA11ySettings(); } catch { /* 忽略 */ } }, 600);
  } else if (allowCtl && !nb) {
    toast('提示：网页端受浏览器安全限制无法被远程控制；手机被控请安装灵犀互传 APK 2.0 并开启无障碍服务', 4600);
  } else {
    toast(allowCtl ? '允许远程控制已开启' : '允许远程控制已关闭');
  }
  historyStore.add('设置', '允许远程控制 ' + (allowCtl ? '开' : '关'));
};

// 检测屏幕共享是否可用（微信内置浏览器等不支持 getDisplayMedia）
function canShareScreen() {
  return !!nativeBridge()
      || !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
}
// 华为鸿蒙 4.x 的 AOSP 兼容层停留在 Android 12，缺少 Android 14+ 的 MediaProjection 接口，
// Chrome/Edge 无论多新都无法屏幕共享 —— 系统级限制，非程序问题
function isHuaweiHarmony() {
  return /HarmonyOS|HUAWEI|HONOR/i.test(navigator.userAgent);
}
function screenUnsupportedTip() {
  if (isHuaweiHarmony()) return '华为鸿蒙系统暂不支持浏览器屏幕共享（系统限制）；摄像头互看正常，看手机屏幕可用华为「多屏协同 / 无线投屏」';
  if (/iPhone|iPad/.test(navigator.userAgent)) return 'iPhone/iPad 暂不支持浏览器屏幕共享（苹果系统限制）；摄像头互看可正常使用';
  return '当前浏览器不支持屏幕共享：安卓需 Chrome 131+ 且系统 Android 14+';
}

// 屏幕待命：提前共享屏幕并保持流，别人点「看TA屏幕」秒接
const screenStandbyToggleEl = $('screenStandbyToggle');
// 供主播开播/停播程序化调用（复用同一个开关逻辑）
async function startStandby() {
  if (screenStandbyToggleEl.checked && standbyStream
      && standbyStream.getVideoTracks().some(t => t.readyState === 'live')) return;
  screenStandbyToggleEl.checked = true;
  await screenStandbyToggleEl.onchange({ target: screenStandbyToggleEl });
}
function stopStandby() {
  if (!screenStandbyToggleEl.checked && !standbyStream) return;
  screenStandbyToggleEl.checked = false;
  screenStandbyToggleEl.onchange({ target: screenStandbyToggleEl });
}
screenStandbyToggleEl.onchange = async e => {
  if (e.target.checked) {
    if (!canShareScreen()) {
      e.target.checked = false;
      toast(screenUnsupportedTip(), 6000);
      addChat('sys', '屏幕共享不可用：' + screenUnsupportedTip());
      return;
    }
    try {
      const wantAudio = vipActive() && soundOn;
      if (nativeBridge()) {
        standbyStream = await getNativeScreen();
      } else {
        standbyStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } },
          audio: wantAudio
        });
      }
      standbyStream.getAudioTracks().forEach(t => { t.enabled = soundOn; });
      // 用户点浏览器"停止共享"→ 待命结束，开关复位；用待命流的连线一并断开
      standbyStream.getVideoTracks()[0].onended = () => {
        stopNativeCapture(true);
        standbyStream = null;
        $('screenStandbyToggle').checked = false;
        toast('屏幕待命已停止');
        for (const c of [...conns.values()]) if (c.mode === 'screen' && c.screenFromStandby) closeConn(c.id, '屏幕共享已停止');
        updateCallUI();
      };
      toast('屏幕待命已开启：别人看你屏幕将秒接通');
      addChat('sys', '屏幕待命已开启' + (nativeBridge() ? '（原生通道）' : '') + '，本机屏幕处于可查看状态');
      historyStore.add('设置', '屏幕待命 开');
    } catch (err) {
      e.target.checked = false;
      if (err.name === 'NotAllowedError') {
        toast('你取消了屏幕共享选择');
      } else {
        toast('屏幕待命开启失败: ' + (err.message || err.name));
      }
    }
  } else {
    if (standbyStream) { standbyStream.getTracks().forEach(t => t.stop()); standbyStream = null; }
    toast('屏幕待命已关闭');
    historyStore.add('设置', '屏幕待命 关');
  }
};

/* ================= WebRTC 互看 / 通话（2.0 多连接 mesh） =================
 * 2.0：同一画面流可同时推给多台观看方（mesh）；观看方可同时连线多台设备，分格显示、点击放大。
 */
const RTC_CONF = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.miwifi.com:3478'] }]
};
const MODE_TEXT = { view: '摄像头', screen: '屏幕', call: '视频通话' };
function modeText(mode) { return MODE_TEXT[mode] || mode; }

function createConn(peerId, name, mode) {
  const key = ckey(peerId, mode);
  if (conns.has(key)) closeConn(conns.get(key), null, false);
  const conn = {
    id: peerId, key, name, mode, pc: new RTCPeerConnection(RTC_CONF), stream: null,
    tile: null, video: null, ctlDc: null, ctlOn: false, rot: 0, pendIce: [],
    micTrack: null, screenFromStandby: false
  };
  conn.pc.onicecandidate = e => {
    if (e.candidate) send({ type: 'ice', to: peerId, mode, candidate: e.candidate });
  };
  conn.pc.ontrack = e => attachRemoteStream(conn, e.streams[0]);
  conn.pc.onconnectionstatechange = () => {
    const st = conn.pc.connectionState;
    if (st === 'disconnected' || st === 'failed') closeConn(conn, '连接中断');
  };
  conns.set(key, conn);
  return conn;
}

function setBusy(b) { send({ type: 'busy', busy: b }); }

function updateCallUI() {
  const n = conns.size;
  els.hangupBtn.classList.toggle('hidden', !n);
  els.recScreenBtn.classList.toggle('hidden', !n);
  els.recAudioBtn.classList.toggle('hidden', !n);
  els.videoPlaceholder.classList.toggle('hidden', n > 0 || !!localStream);
  setBusy(n > 0);
  if (n > 0) {
    const names = [...conns.values()].map(c => c.name).join('、');
    els.videoStatus.textContent = `连线中 · ${n} 路 · ${names}`;
    switchTab('video');  // 手机端自动切到互看页
  } else {
    els.videoStatus.textContent = localStream ? '本机预览中' : '';
  }
}

/* ---- 远端画面：分格网格 + 点击放大 + 画中画（3.0 同屏共看） ---- */
function attachRemoteStream(conn, stream) {
  conn.stream = stream;
  if (!conn.tile) {
    const tile = document.createElement('div');
    tile.className = 'rtile mode-' + conn.mode;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="rtile-label"></div>
      <div class="rtile-tools">
        <button data-t="mute" title="声音：默认开启，点击静音/恢复">🔊</button>
        <button data-t="fs" title="全屏显示（VIP）">⛶</button>
        <button data-t="rot" title="横竖切换（VIP）">⟳</button>
        <button data-t="ctl" title="远程控制对方（VIP，需对方允许）">🖱</button>
        <button data-t="close" title="断开此路">✕</button>
      </div>
      <div class="rtile-mode-tag"></div>
      <div class="ctl-overlay hidden"></div>`;
    conn.tile = tile;
    conn.video = tile.querySelector('video');
    tile.querySelector('.rtile-label').textContent = `${conn.name} · ${modeText(conn.mode)}`;
    tile.querySelector('.rtile-mode-tag').textContent = modeText(conn.mode);
    // 点画面（非工具区、非控制模式）→ 放大/返回分格
    tile.onclick = e => {
      if (e.target.closest('.rtile-tools') || conn.ctlOn) return;
      toggleFocus(conn.key);
    };
    const tools = tile.querySelector('.rtile-tools');
    tools.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      const t = b.dataset.t;
      if (t === 'mute') {
        conn.video.muted = !conn.video.muted;
        b.textContent = conn.video.muted ? '🔇' : '🔊';
        b.classList.toggle('on', conn.video.muted);
      }
      else if (t === 'fs') { if (vipGate('全屏显示')) toggleFullscreen(conn); }
      else if (t === 'rot') { if (vipGate('横竖切换')) rotateTile(conn); }
      else if (t === 'ctl') toggleCtl(conn);
      else if (t === 'close') closeConn(conn, '本机断开');
    };
    wireCtlOverlay(conn, tile.querySelector('.ctl-overlay'));
    els.remoteGrid.appendChild(tile);
  }
  conn.video.srcObject = stream;
  conn.video.muted = false;   // 声音默认开启（可关）
  const p = conn.video.play();
  if (p && p.catch) p.catch(() => {
    // 浏览器自动播放策略拦截有声播放：降级静音并提示手动开声音
    conn.video.muted = true;
    const mb = conn.tile && conn.tile.querySelector('[data-t="mute"]');
    if (mb) { mb.textContent = '🔇'; mb.classList.add('on'); }
    toast('浏览器拦截了自动发声，点画面右上角 🔊 开启声音', 4000);
  });
  updateCallUI();
  layoutPip();
  // 从「远程控制」入口发起：画面就绪后自动开启控制层
  if (pendingCtlPeer === conn.key) { pendingCtlPeer = null; toggleCtl(conn, true); toast('远程控制已就绪：在画面上点按/拖动即操作对方手机', 3600); }
}

/* 3.0 画中画：只要存在屏幕画面，摄像头画面自动缩到右下角小窗，互不遮挡 */
function layoutPip() {
  const hasScreen = [...conns.values()].some(c => c.mode === 'screen' && c.tile);
  let anyPip = false;
  for (const c of conns.values()) {
    if (!c.tile) continue;
    const pip = hasScreen && c.mode === 'view';
    c.tile.classList.toggle('pip', pip);
    if (pip) anyPip = true;
  }
  els.localVideo.classList.toggle('under-pip', anyPip);
}

function toggleFocus(key) {
  const conn = conns.get(key);
  if (!conn || !conn.tile) return;
  if (conns.size > 1 && !vipGate('多人连线放大')) return;
  const grid = els.remoteGrid;
  if (focusedPeer === key) {
    focusedPeer = null;
    grid.classList.remove('has-focus');
    conn.tile.classList.remove('focus');
  } else {
    if (focusedPeer && conns.get(focusedPeer)) conns.get(focusedPeer).tile.classList.remove('focus');
    focusedPeer = key;
    grid.classList.add('has-focus');
    conn.tile.classList.add('focus');
  }
}

/* 3.0 全屏：兼容电脑浏览器 / 安卓浏览器 / iOS（video.webkitEnterFullscreen）/ 不支持API时用CSS伪全屏 */
async function toggleFullscreen(conn) {
  const el = conn.tile;
  const v = conn.video;
  if (!el) return;
  // 已在（伪）全屏 → 退出
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { /* 忽略 */ }
    return;
  }
  if (el.classList.contains('pseudo-fs')) { el.classList.remove('pseudo-fs'); document.body.classList.remove('fs-lock'); return; }

  // iOS Safari：只能用视频元素自带全屏
  if (v && /iPhone|iPad|iPod/i.test(navigator.userAgent) && typeof v.webkitEnterFullscreen === 'function') {
    try { v.webkitEnterFullscreen(); historyStore.add('全屏显示', conn.name); return; } catch { /* 继续走通用方案 */ }
  }
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (req) {
    try { await req.call(el); historyStore.add('全屏显示', conn.name); return; } catch { /* 回退伪全屏 */ }
  }
  // 兜底：CSS 伪全屏（微信/部分安卓浏览器不支持 Fullscreen API，之前手机端点全屏失败就是这个原因）
  el.classList.add('pseudo-fs');
  document.body.classList.add('fs-lock');
  toast('已进入全屏（点 ⛶ 或双击画面退出）', 2800);
  historyStore.add('全屏显示', conn.name + '（兼容模式）');
}
document.addEventListener('dblclick', e => {
  const t = e.target.closest && e.target.closest('.rtile.pseudo-fs');
  if (t) { t.classList.remove('pseudo-fs'); document.body.classList.remove('fs-lock'); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const t = document.querySelector('.rtile.pseudo-fs');
    if (t) { t.classList.remove('pseudo-fs'); document.body.classList.remove('fs-lock'); }
  }
});

function rotateTile(conn) {
  conn.rot = (conn.rot + 90) % 360;
  const v = conn.video;
  if (conn.rot % 180) {
    // 横竖互换：按宽高比缩放，旋转后铺满不裁剪
    const vw = v.videoWidth || 9, vh = v.videoHeight || 16;
    v.style.transform = `rotate(${conn.rot}deg) scale(${vw / vh})`;
  } else {
    v.style.transform = conn.rot ? `rotate(${conn.rot}deg)` : '';
  }
  historyStore.add('横竖切换', `${conn.name} 旋转至 ${conn.rot}°`);
}

function closeConn(target, reason, notify = true) {
  const conn = typeof target === 'string' ? conns.get(target) : target;
  if (!conn) return;
  const key = conn.key || ckey(conn.id, conn.mode);
  conns.delete(key);
  if (notify) { try { send({ type: 'hangup', to: conn.id, mode: conn.mode }); } catch { /* 忽略 */ } }
  try { conn.pc.close(); } catch { /* 忽略 */ }
  if (conn.tile) { try { conn.tile.remove(); } catch { /* 忽略 */ } }
  if (focusedPeer === key) {
    focusedPeer = null;
    els.remoteGrid.classList.remove('has-focus');
  }
  // 最后一路断开：释放非待命屏幕流与麦克风、停录制、恢复本机预览/占位
  if (!conns.size) {
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    stopAllRecs();
    if (localStream) {
      els.localVideo.srcObject = localStream;
      els.localVideo.classList.add('full');
    } else {
      els.localVideo.classList.add('hidden');
      els.localVideo.classList.remove('full');
    }
    els.incomingBar.classList.add('hidden');
  }
  updateCallUI();
  layoutPip();
  if (reason) addChat('sys', `与 ${conn.name} 的${modeText(conn.mode)}连线已断开: ${reason}`);
  if (reason) historyStore.add('断开连线', `${conn.name} ${modeText(conn.mode)} (${reason})`);
}

function closePeerConns(peerId, reason, notify = true) {
  for (const c of connsOfPeer(peerId)) closeConn(c, reason, notify);
}

function closeAllConns(reason) {
  for (const c of [...conns.values()]) closeConn(c, reason);
}

// 发起连线前检查：同一台设备的「摄像头+屏幕」可免费同看；多台设备同时连线为 VIP 能力
function canStartConn(peerId) {
  if (!vipActive()) {
    const other = [...conns.values()].find(c => c.id !== peerId);
    if (other) { vipGate('多人同时连线'); return false; }
  }
  return true;
}

// 发起「看看TA」（单向：对方开摄像头，我观看）
window.startView = async peerId => {
  if (connOf(peerId, 'view')) return toast('已在看该设备的摄像头');
  if (!canStartConn(peerId)) return;
  const peer = peerList.find(p => p.id === peerId);
  if (!peer) return;
  send({ type: 'call-request', to: peerId, mode: 'view' });
  els.videoStatus.textContent = '等待对方同意…';
  els.videoPlaceholder.classList.add('hidden');
  if (connOf(peerId, 'screen')) toast('已发起摄像头请求：接通后会自动缩到右下角小窗（同屏共看）', 3600);
  else toast('已向 ' + peer.name + ' 发起「看看TA」请求');
  historyStore.add('请求查看摄像头', peer.name);
};

// 发起「看TA屏幕」（单向：对方共享屏幕，我观看）
// auto=true 时为主播自动订阅：不弹提示、不受多人 VIP 限制
window.startViewScreen = async (peerId, auto) => {
  if (connOf(peerId, 'screen')) return;
  if (!auto && !canStartConn(peerId)) return;
  const peer = peerList.find(p => p.id === peerId);
  if (!peer) return;
  send({ type: 'call-request', to: peerId, mode: 'screen' });
  if (auto) return;
  els.videoStatus.textContent = '等待对方同意共享屏幕…';
  els.videoPlaceholder.classList.add('hidden');
  if (connOf(peerId, 'view')) toast('已发起屏幕请求：接通后摄像头画面会缩到右下角小窗', 3600);
  else toast('已向 ' + peer.name + ' 发起「看TA屏幕」请求');
  historyStore.add('请求查看屏幕', peer.name);
};

// 发起「视频通话」（双向）
window.startCall = async peerId => {
  if (connOf(peerId, 'call')) return toast('已与该设备视频通话中');
  if (!canStartConn(peerId)) return;
  const peer = peerList.find(p => p.id === peerId);
  if (!peer) return;
  try {
    await getCamera();
  } catch { return; }
  send({ type: 'call-request', to: peerId, mode: 'call' });
  els.videoStatus.textContent = '等待对方接听…';
  els.videoPlaceholder.classList.add('hidden');
  toast('正在呼叫 ' + peer.name + '…');
  historyStore.add('发起视频通话', peer.name);
};

// 发起「远程控制」（手机被控，VIP）：看屏幕 + 画面就绪后自动开启控制层
window.startCtl = async peerId => {
  if (!vipGate('远程控制')) return;
  const peer = peerList.find(p => p.id === peerId);
  if (!peer) return;
  if (!(peer.caps && peer.caps.ctl)) {
    return toast(`「${peer.name}」不支持被控：手机需安装灵犀互传 APK 3.0 并开启无障碍服务`, 4600);
  }
  pendingCtlPeer = ckey(peerId, 'screen');
  startViewScreen(peerId);
  historyStore.add('发起远程控制', peer.name);
};

// 收到呼叫（3.0 mesh：同一设备可同时有摄像头/屏幕多路，按模式判定重复）
function onIncomingCall(msg) {
  const mode = msg.mode || 'view';
  if (connOf(msg.from, mode)) { send({ type: 'reject', to: msg.from, mode, reason: 'dup' }); return; }
  const what = mode === 'call' ? '视频通话' : mode === 'screen' ? '看我屏幕' : '看看我';
  // 主播：任何人请求看画面都自动接通（主播就是要给大家看）
  if (myRole === 'anchor') {
    historyStore.add('主播自动接通', `${msg.fromName} (${what})`);
    addChat('sys', `${msg.fromName} 正在观看你的主播画面`);
    doAccept(msg.from, mode, msg.fromName);
    return;
  }
  if (autoAnswer) {
    historyStore.add('自动应答', `${msg.fromName} (${what})`);
    doAccept(msg.from, mode, msg.fromName);
    return;
  }
  pendingIncoming = { from: msg.from, mode, fromName: msg.fromName };
  els.incomingText.textContent = mode === 'call'
    ? `📞 ${msg.fromName} 邀请你视频通话`
    : mode === 'screen'
      ? `🖥 ${msg.fromName} 想看看你的电脑屏幕`
      : `👁 ${msg.fromName} 想看看你的摄像头`;
  els.incomingBar.classList.remove('hidden');
  switchTab('video');
  historyStore.add('收到呼叫', `${msg.fromName} (${what})`);
}

// 接听方（被看方）：按模式准备画面流 → 建 PC → 主动发 offer。
// 多人旁观时同一画面流复用推给多路；屏幕模式优先用「屏幕待命」流秒接。
async function doAccept(from, mode, fromName) {
  let stream;
  try {
    if (mode === 'screen') {
      if (standbyStream && standbyStream.getVideoTracks().some(t => t.readyState === 'live')) {
        stream = standbyStream;
      } else if (screenStream && screenStream.getVideoTracks().some(t => t.readyState === 'live')) {
        stream = screenStream;   // 已在共享中，复用
      } else {
        stream = await getScreen();
        screenStream = stream;
      }
      // VIP 声音：叠加本机麦克风（系统/扬声器声音在采集时已随 audio:true 带上）
      if (vipActive() && soundOn) {
        try { await getMic(); } catch { /* 麦克风不可用时降级为无声 */ }
      }
    } else {
      stream = await getCamera();
    }
  } catch {
    send({ type: 'reject', to: from, reason: mode === 'screen' ? 'no-screen' : 'no-camera' });
    return;
  }
  const conn = createConn(from, fromName || '对方', mode);
  conn.screenFromStandby = (mode === 'screen' && stream === standbyStream);
  // 发布轨道：画面 + 已有系统声 + 麦克风
  const pub = new MediaStream();
  stream.getTracks().forEach(t => pub.addTrack(t));
  if (mode === 'screen' && micStream) {
    micStream.getAudioTracks().forEach(t => { t.enabled = soundOn; pub.addTrack(t); conn.micTrack = t; });
  }
  pub.getTracks().forEach(t => conn.pc.addTrack(t, pub));
  // 远程控制数据通道（被控方创建，控制方经 ondatachannel 接收，双向可通）
  conn.ctlDc = conn.pc.createDataChannel('ctl');
  wireCtlReceiver(conn);
  // 本机小窗预览自己发出的画面
  els.localVideo.srcObject = stream;
  els.localVideo.classList.remove('hidden');
  els.localVideo.classList.remove('full');
  const offer = await conn.pc.createOffer();
  await conn.pc.setLocalDescription(offer);
  send({ type: 'offer', to: from, sdp: offer, mode });
  updateCallUI();
  historyStore.add(mode === 'call' ? '接通视频通话' : mode === 'screen' ? '共享屏幕给对方' : '开启摄像头给对方', conn.name);
}

els.acceptBtn.onclick = () => {
  const inc = pendingIncoming; pendingIncoming = null;
  els.incomingBar.classList.add('hidden');
  if (inc) doAccept(inc.from, inc.mode, inc.fromName);
};

els.rejectBtn.onclick = () => {
  const inc = pendingIncoming; pendingIncoming = null;
  if (inc) send({ type: 'reject', to: inc.from });
  els.incomingBar.classList.add('hidden');
  historyStore.add('拒绝呼叫', '');
};

els.hangupBtn.onclick = () => {
  closeAllConns('本机挂断');
  historyStore.add('挂断全部', '');
};

// 信令：offer / answer / ice（观看方收 offer 直接 recvonly 收流；视频通话双方互发）
async function onOffer(msg) {
  const mode = msg.mode || 'call';
  const old = connOf(msg.from, mode);
  if (old) closeConn(old, null, false);   // 重协商场景：先清旧连接
  const conn = createConn(msg.from, msg.fromName || '对方', mode);
  conn.pc.ondatachannel = e => {
    if (e.channel.label === 'ctl') { conn.ctlDc = e.channel; wireCtlSender(conn); }
  };
  if (mode === 'call') {
    try { await getCamera(); } catch {
      send({ type: 'reject', to: msg.from, mode, reason: 'no-camera' });
      conns.delete(ckey(msg.from, mode));
      try { conn.pc.close(); } catch { /* 忽略 */ }
      return;
    }
    localStream.getTracks().forEach(t => conn.pc.addTrack(t, localStream));
    els.localVideo.srcObject = localStream;
    els.localVideo.classList.remove('hidden');
    els.localVideo.classList.remove('full');
  }
  await conn.pc.setRemoteDescription(msg.sdp);
  for (const c of conn.pendIce) { await conn.pc.addIceCandidate(c).catch(() => {}); }
  conn.pendIce = [];
  const answer = await conn.pc.createAnswer();
  await conn.pc.setLocalDescription(answer);
  send({ type: 'answer', to: msg.from, sdp: answer, mode });
  updateCallUI();
  historyStore.add(mode === 'call' ? '接通视频通话' : mode === 'screen' ? '查看对方屏幕' : '查看对方摄像头', conn.name);
}

async function onAnswer(msg) {
  const conn = findConnByFrom(msg);
  if (!conn) return;
  await conn.pc.setRemoteDescription(msg.sdp);
  for (const c of conn.pendIce) { await conn.pc.addIceCandidate(c).catch(() => {}); }
  conn.pendIce = [];
}

async function onIce(msg) {
  const conn = findConnByFrom(msg);
  if (!conn) return;
  const cand = new RTCIceCandidate(msg.candidate);
  if (conn.pc.remoteDescription) await conn.pc.addIceCandidate(cand).catch(() => {});
  else conn.pendIce.push(cand);
}

/* ================= 录屏 / 录音（VIP） =================
 * MediaRecorder 录制对方画面流：录屏=画面+声音(webm)，录音=仅声音(webm)；
 * 网页端停止后自动下载，APK 内经原生桥保存到手机下载目录。
 */
const recs = {};   // kind('screen'|'audio') -> { mr, chunks }
function pickRecConn() {
  return (focusedPeer && conns.get(focusedPeer)) || conns.values().next().value || null;
}
function toggleRec(kind) {
  if (!vipGate(kind === 'audio' ? '录音' : '录屏')) return;
  if (recs[kind]) { stopRec(kind); return; }
  const conn = pickRecConn();
  if (!conn || !conn.stream) return toast('请先连线对方画面');
  let st;
  if (kind === 'audio') {
    const at = conn.stream.getAudioTracks();
    if (!at.length) return toast('对方未开启声音，无法录音');
    st = new MediaStream(at);
  } else st = conn.stream;
  const mime = kind === 'audio' ? 'audio/webm' : 'video/webm;codecs=vp9,opus';
  let mr;
  try { mr = new MediaRecorder(st, { mimeType: MediaRecorder.isTypeSupported(mime) ? mime : '' }); }
  catch { return toast('当前浏览器不支持录制'); }
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = () => saveRec(kind, chunks);
  mr.start(1000);
  recs[kind] = { mr, chunks };
  const btn = kind === 'audio' ? els.recAudioBtn : els.recScreenBtn;
  btn.classList.add('on');
  btn.textContent = kind === 'audio' ? '⏹ 停止录音' : '⏹ 停止录屏';
  toast((kind === 'audio' ? '录音' : '录屏') + '已开始（' + conn.name + '），再点一次停止并保存');
  historyStore.add(kind === 'audio' ? '开始录音' : '开始录屏', conn.name);
}
function stopRec(kind) {
  const r = recs[kind];
  if (!r) return;
  delete recs[kind];
  try { r.mr.stop(); } catch { /* 忽略 */ }
  const btn = kind === 'audio' ? els.recAudioBtn : els.recScreenBtn;
  btn.classList.remove('on');
  btn.textContent = kind === 'audio' ? '🎙 录音' : '⏺ 录屏';
}
function stopAllRecs() { stopRec('screen'); stopRec('audio'); }
async function saveRec(kind, chunks) {
  if (!chunks.length) return;
  const blob = new Blob(chunks, { type: kind === 'audio' ? 'audio/webm' : 'video/webm' });
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const name = `灵犀${kind === 'audio' ? '录音' : '录屏'}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.webm`;
  const nb = nativeBridge();
  if (nb && typeof nb.saveFile === 'function') {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      nb.saveFile(name, btoa(bin));
      toast(`已保存到手机下载目录: ${name}`, 4200);
    } catch { toast('保存到手机失败'); }
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`已保存: ${name}`);
  }
  historyStore.add(kind === 'audio' ? '保存录音' : '保存录屏', `${name} (${fmtSize(blob.size)})`);
  addChat('sys', `${kind === 'audio' ? '录音' : '录屏'}已保存: ${name} (${fmtSize(blob.size)})`);
}
els.recScreenBtn.onclick = () => toggleRec('screen');
els.recAudioBtn.onclick = () => toggleRec('audio');

/* ================= 远程控制（VIP） =================
 * 控制方：在画面上叠加透明层采集鼠标/触屏/键盘事件，按远端画面归一化坐标经 DataChannel 发送；
 * 被控方：仅 APK 可执行（无障碍服务 dispatchGesture / 节点输入），网页端受沙箱限制回 ctl-unsupported。
 */
function toggleCtl(conn, silent) {
  if (!vipGate('远程控制')) return;
  conn.ctlOn = !conn.ctlOn;
  const ov = conn.tile && conn.tile.querySelector('.ctl-overlay');
  const btn = conn.tile && conn.tile.querySelector('[data-t="ctl"]');
  if (ov) ov.classList.toggle('hidden', !conn.ctlOn);
  if (btn) btn.classList.toggle('on', conn.ctlOn);
  if (conn.tile) conn.tile.classList.toggle('ctl-on', conn.ctlOn);
  if (conn.ctlOn && !silent) toast('远程控制已开启：在画面上点按/拖动/滚轮/键盘输入即控制对方；再点 🖱 关闭', 4200);
  if (conn.ctlOn) historyStore.add('开启远程控制', conn.name);
}

// 控制方：ondatachannel 拿到通道后接收被控方回执
function wireCtlSender(conn) {
  conn.ctlDc.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'ctl-denied') toast(`「${conn.name}」未开启「允许远程控制」`, 3600);
    else if (m.type === 'ctl-unsupported') toast(`「${conn.name}」设备不支持被控（需灵犀互传 APK 2.0+ 并开启无障碍服务）`, 4600);
  };
}

// 被控方：收到控制指令 → 校验总开关 → 交原生桥执行
function wireCtlReceiver(conn) {
  conn.ctlDc.onmessage = e => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    const dc = conn.ctlDc;
    if (!allowCtl) { try { dc.send(JSON.stringify({ type: 'ctl-denied' })); } catch { /* 忽略 */ } return; }
    const nb = nativeBridge();
    if (!nb || typeof nb.control !== 'function') {
      try { dc.send(JSON.stringify({ type: 'ctl-unsupported' })); } catch { /* 忽略 */ }
      return;
    }
    try { nb.control(JSON.stringify(ev)); } catch { /* 忽略 */ }
  };
}

// 控制坐标换算：object-fit:contain 的实际显示区域 + 旋转角还原为原始画面坐标
function ctlPos(conn, clientX, clientY) {
  const v = conn.video;
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth || 1080, vh = v.videoHeight || 1920;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
  let x = (clientX - left) / w, y = (clientY - top) / h;
  x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
  const rot = conn.rot % 360;
  if (rot === 90) { const t = x; x = y; y = 1 - t; }
  else if (rot === 180) { x = 1 - x; y = 1 - y; }
  else if (rot === 270) { const t = x; x = 1 - y; y = t; }
  return { x: +x.toFixed(4), y: +y.toFixed(4) };
}
function ctlSend(conn, ev) {
  if (conn.ctlDc && conn.ctlDc.readyState === 'open') conn.ctlDc.send(JSON.stringify(ev));
}
function wireCtlOverlay(conn, ov) {
  let downPos = null, downTime = 0, lastMove = 0;
  ov.addEventListener('mousedown', e => { e.preventDefault(); downPos = { x: e.clientX, y: e.clientY }; downTime = Date.now(); });
  ov.addEventListener('mouseup', e => {
    if (!downPos) return;
    const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    const dur = Date.now() - downTime;
    if (dist < 12 && dur < 400) {
      const p = ctlPos(conn, e.clientX, e.clientY);
      ctlSend(conn, { a: 'tap', x: p.x, y: p.y });
    } else {
      const p1 = ctlPos(conn, downPos.x, downPos.y), p2 = ctlPos(conn, e.clientX, e.clientY);
      ctlSend(conn, { a: 'swipe', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, d: Math.max(120, dur) });
    }
    downPos = null;
  });
  ov.addEventListener('mousemove', e => {
    if (downPos) return;   // 拖动中不发 move
    const now = Date.now();
    if (now - lastMove < 60) return;
    lastMove = now;
    const p = ctlPos(conn, e.clientX, e.clientY);
    ctlSend(conn, { a: 'move', x: p.x, y: p.y });
  });
  ov.addEventListener('wheel', e => {
    e.preventDefault();
    const p = ctlPos(conn, e.clientX, e.clientY);
    const dy = e.deltaY > 0 ? 0.18 : -0.18;
    ctlSend(conn, { a: 'swipe', x1: p.x, y1: p.y, x2: p.x, y2: Math.min(1, Math.max(0, p.y + dy)), d: 220 });
  }, { passive: false });
  // 右键 = 安卓返回键
  ov.addEventListener('contextmenu', e => { e.preventDefault(); ctlSend(conn, { a: 'key', k: 'back' }); });
  // 触屏（手机控制手机）
  ov.addEventListener('touchstart', e => {
    const t = e.touches[0];
    downPos = { x: t.clientX, y: t.clientY }; downTime = Date.now();
  }, { passive: true });
  ov.addEventListener('touchend', e => {
    if (!downPos) return;
    const t = e.changedTouches[0];
    const dist = Math.hypot(t.clientX - downPos.x, t.clientY - downPos.y);
    const dur = Date.now() - downTime;
    if (dist < 16 && dur < 400) {
      const p = ctlPos(conn, t.clientX, t.clientY);
      ctlSend(conn, { a: 'tap', x: p.x, y: p.y });
    } else {
      const p1 = ctlPos(conn, downPos.x, downPos.y), p2 = ctlPos(conn, t.clientX, t.clientY);
      ctlSend(conn, { a: 'swipe', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, d: Math.max(120, dur) });
    }
    downPos = null;
  });
}
// 控制激活时接管键盘：可打印字符按文本输入，特殊键映射安卓按键
document.addEventListener('keydown', e => {
  if (rdpActive) return;   // 远程桌面窗口激活时不冲突
  const conn = [...conns.values()].find(c => c.ctlOn);
  if (!conn) return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1) ctlSend(conn, { a: 'text', t: e.key });
  else if (e.key === 'Enter') ctlSend(conn, { a: 'key', k: 'enter' });
  else if (e.key === 'Backspace') ctlSend(conn, { a: 'key', k: 'del' });
  else if (e.key === 'Escape') ctlSend(conn, { a: 'key', k: 'back' });
  else return;
  e.preventDefault();
});

/* ================= 消息 ================= */
function addChat(cls, text, link) {
  const ts = Date.now();
  chatLines.push({ cls, text, link: link || '', ts });
  if (chatLines.length > 2000) chatLines.shift();
  if (els.chatCount) els.chatCount.textContent = `${chatLines.length} 条`;

  const div = document.createElement('div');
  div.className = cls;
  const time = new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  div.appendChild(document.createTextNode(`[${time}] ${text}`));
  // 3.0：文件缓存链接可直接点击重复下载
  if (link) {
    const sep = document.createTextNode(' ');
    const a = document.createElement('a');
    a.href = link; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = '⇩ 点此下载（10分钟内有效）';
    a.className = 'cache-dl';
    div.appendChild(sep); div.appendChild(a);
  }
  els.chatLog.appendChild(div);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

/* 3.0：消息记录导出 TXT */
function exportChat() {
  if (!chatLines.length) return toast('暂无消息可导出');
  const pad = n => String(n).padStart(2, '0');
  const d = new Date();
  const head = [
    '灵犀互传 3.0 商用版 · 消息记录',
    `导出时间: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    `本机设备: ${myName}  房间: ${myRoom === 'public' ? '公共大厅' : myRoom}`,
    `作者: 军哥懂保 (微信: xunijiayuan)`,
    '-'.repeat(52), '',
  ].join('\r\n');
  const body = chatLines.map(l => {
    const t = new Date(l.ts);
    const stamp = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    return `[${stamp}] ${l.text}${l.link ? '  ' + l.link : ''}`;
  }).join('\r\n');
  const blob = new Blob(['\ufeff' + head + body + '\r\n'], { type: 'text/plain;charset=utf-8' });
  const name = `灵犀互传消息记录_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
  if (nativeBridge() && typeof nativeBridge().saveFile === 'function') {
    const fr = new FileReader();
    fr.onload = () => { try { nativeBridge().saveFile(name, String(fr.result).split(',')[1]); addChat('sys', `消息记录已保存: ${name}`); } catch { toast('保存失败'); } };
    fr.readAsDataURL(blob);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  addChat('sys', `消息记录已导出: ${name}`);
  historyStore.add('导出消息', `${chatLines.length} 条`);
}

/* ================= 3.0 主播模式 =================
 * 房主 = 第一个进房的人，负责审批主播；主播开播后房间所有人自动观看画面并听声音。
 */
function applyRoles(r) {
  if (!r) return;
  const prevHost = roomRoles.host;
  roomRoles = { host: r.host || '', hostName: r.hostName || '', anchors: Array.isArray(r.anchors) ? r.anchors.slice() : [] };
  myRole = roomRoles.host === myId ? 'host' : (roomRoles.anchors.includes(myId) ? 'anchor' : '');
  if (prevHost !== roomRoles.host && roomRoles.hostName) {
    // 房主变更不额外刷屏，仅在调试记录里留痕
    historyStore.add('房主变更', roomRoles.hostName);
  }
  // 主播身份变更：非主播时若正在直播，自动停止
  if (myRole !== 'anchor' && anchorLive) stopAnchorLive(true);
  updateAnchorUI();
  // 自己不再是房主则取消待审批提示
  if (myRole !== 'host' && anchorPendingFrom) { anchorPendingFrom = null; els.anchorPending.classList.add('hidden'); }
  scheduleAnchorSubscribe();
  // 角色变更后重绘设备列表（房主按钮/主播徽标）
  if (lastPeersRaw.length) renderPeers(lastPeersRaw);
}

function updateAnchorUI() {
  const isHost = myRole === 'host', isAnchor = myRole === 'anchor';
  if (els.anchorState) els.anchorState.textContent = isHost ? '房主' : isAnchor ? (anchorLive ? '直播中' : '主播') : '观众';
  if (els.anchorLiveBtn) els.anchorLiveBtn.classList.toggle('hidden', !isAnchor);
  if (els.anchorLiveBtn) els.anchorLiveBtn.textContent = anchorLive ? '■ 停止直播' : '▶ 开始直播';
  if (els.anchorQuitBtn) els.anchorQuitBtn.classList.toggle('hidden', !isAnchor);
  if (els.anchorApplyBtn) {
    els.anchorApplyBtn.classList.toggle('hidden', isAnchor || isHost || !roomRoles.host);
    els.anchorApplyBtn.disabled = !roomRoles.host;
    els.anchorApplyBtn.textContent = roomRoles.host ? '申请成为主播' : '等待房主上线…';
  }
  if (els.anchorTip) {
    els.anchorTip.textContent = isHost
      ? '你是房主：可在左侧设备列表点「设为主播」授权成员；主播开播后，新进房的人会自动看到主播画面并听到主播声音。'
      : isAnchor
        ? '你已成为主播：点「开始直播」共享本机屏幕+声音，房间内所有人自动观看。'
        : roomRoles.host
          ? '房主负责审批主播。你也可以申请成为主播，房主同意后即可开播。'
          : '房主 = 第一个进入房间的人，负责审批主播。主播开播后，进入房间的人会自动看到主播屏幕并听到主播声音。';
  }
  if (els.myRoleBadge) {
    els.myRoleBadge.classList.toggle('hidden', !myRole);
    els.myRoleBadge.className = 'role-chip ' + (isHost ? 'host' : 'anchor') + (myRole ? '' : ' hidden');
    els.myRoleBadge.textContent = isHost ? '👑 房主' : isAnchor ? '🎙 主播' : '';
  }
}

// 房主侧：收到主播申请
function onAnchorRequest(msg) {
  if (myRole !== 'host') { send({ type: 'anchor-answer', to: msg.from, ok: false }); return; }
  if (roomRoles.anchors.includes(msg.from)) return;   // 已是主播
  anchorPendingFrom = { id: msg.from, name: msg.fromName || msg.name || '对方' };
  els.anchorPendingText.textContent = `🎙 ${anchorPendingFrom.name} 申请成为主播，是否同意？`;
  els.anchorPending.classList.remove('hidden');
  addChat('sys', `🎙 ${anchorPendingFrom.name} 申请成为主播，等待房主审批`);
  toast(`${anchorPendingFrom.name} 申请成为主播`);
}

function answerAnchor(ok) {
  const p = anchorPendingFrom;
  anchorPendingFrom = null;
  els.anchorPending.classList.add('hidden');
  if (!p) return;
  send({ type: 'anchor-answer', to: p.id, ok });
  addChat('sys', `房主${ok ? '同意' : '拒绝'}了 ${p.name} 的主播申请`);
}

// 房主侧：设置/取消主播（设备列表按钮调用）
function toggleAnchor(peerId, on) {
  if (myRole !== 'host') return toast('只有房主可以设置主播');
  send({ type: on ? 'anchor-set' : 'anchor-unset', to: peerId });
}

// 观众侧：自动订阅房间里已开播的主播（每人只处理一次）
function scheduleAnchorSubscribe() {
  if (!els.anchorWatchToggle || !els.anchorWatchToggle.checked) return;
  const peers = peerList.filter(p => p.role === 'anchor' && p.live === true);
  for (const p of peers) {
    if (p.id === myId) continue;
    if (subscribedAnchors.has(p.id)) continue;
    subscribedAnchors.add(p.id);
    // 主播开播即推流：发起「看TA屏幕」+ 声音
    startViewScreen(p.id, true);
    addChat('sys', `🎙 主播「${p.name}」正在直播，已自动开始观看`);
  }
}

// 主播侧：开始/停止直播（开播即进入屏幕待命，任何人请求自动接通）
async function startAnchorLive() {
  if (myRole !== 'anchor') return toast('你还不是主播，请先向房主申请');
  if (anchorLive) { stopAnchorLive(); return; }
  try {
    await startStandby();   // 屏幕待命：开播即准备共享，观看请求自动接通
    if (!standbyStream) return;   // 用户取消了选屏
    anchorLive = true;
    updateAnchorUI();
    send({ type: 'anchor-live', live: true });
    addChat('sys', '🎙 直播已开始：房间内所有人可观看你的屏幕并听到你的声音');
    historyStore.add('开始直播', '');
  } catch {
    toast('开始直播失败：屏幕共享权限被拒绝');
  }
}
function stopAnchorLive(silent) {
  if (!anchorLive) return;
  anchorLive = false;
  updateAnchorUI();
  stopStandby();
  send({ type: 'anchor-live', live: false });
  if (!silent) addChat('sys', '直播已结束');
}

function quitAnchor() {
  send({ type: 'anchor-quit' });
  addChat('sys', '已退出主播身份');
}

/* 3.0：名词解析（大白话） */
function bindGlossary() {
  const btn = $('glossaryBtn'), modal = els.glossaryModal;
  if (!btn || !modal) return;
  btn.onclick = () => modal.classList.remove('hidden');
  const close = $('glossaryCloseBtn');
  if (close) close.onclick = () => modal.classList.add('hidden');
  modal.onclick = e => { if (e.target === modal) modal.classList.add('hidden'); };
}

/* 3.0：文件服务器缓存（VIP，10 分钟可重复下载） */
async function cacheToServer(file) {
  if (!vipActive()) return null;
  try {
    const ttl = 600;
    const apiBase = /\.github\.io$/i.test(location.hostname) ? 'https://tools.ecojia.cn' : location.origin;
    const url = `${apiBase}/c3/upload?name=${encodeURIComponent(file.name)}&ttl=${ttl}`;
    const res = await fetch(url, { method: 'POST', body: file });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || !j.url) return null;
    const full = apiBase + j.url + (j.url.includes('?') ? '&' : '?') + 'n=' + encodeURIComponent(file.name);
    return full;
  } catch { return null; }
}

function sendChat() {
  const target = els.chatTarget.value;
  const text = els.chatInput.value.trim();
  if (!target) return toast('请先选择设备');
  if (!text) return;
  send({ type: 'chat', to: target, text });
  addChat('me', `我: ${text}`);
  historyStore.add('发送消息', `给 ${peerList.find(p => p.id === target)?.name || target}`);
  els.chatInput.value = '';
}
els.chatSendBtn.onclick = sendChat;
els.chatInput.onkeydown = e => { if (e.key === 'Enter') sendChat(); };

/* ================= 文件互传（WebRTC DataChannel 点对点直传） =================
 * 云端版不走服务器中转：文件经 P2P 数据通道直接送达对方浏览器，不限大小、不占服务器带宽。
 * 流程：file-offer → 对方点接收 file-accept → 建立独立 PC+DataChannel → 分块发送 → 对方自动下载
 */
const FILE_CHUNK = 16384;

els.pickFileBtn.onclick = () => els.fileInput.click();
els.fileInput.onchange = () => { sendFiles([...els.fileInput.files]); els.fileInput.value = ''; };

['dragover', 'dragleave', 'drop'].forEach(ev => {
  els.dropZone.addEventListener(ev, e => {
    e.preventDefault();
    els.dropZone.classList.toggle('over', ev === 'dragover');
    if (ev === 'drop') sendFiles([...e.dataTransfer.files]);
  });
});

function sendFiles(files) {
  if (!files.length) return;
  const targetId = els.fileTarget.value;
  if (!targetId) return toast('请先选择要发送到的设备');
  const peer = peerList.find(p => p.id === targetId);
  if (!peer) return toast('设备不在线，无法发送');

  for (const file of files) {
    const fileId = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const item = document.createElement('div');
    item.className = 'transfer-item';
    item.innerHTML = `
      <div class="tname">⇪ ${escapeHtml(file.name)}</div>
      <div class="tinfo"><span>${fmtSize(file.size)}</span><span class="pct">等待对方接收…</span></div>
      <div class="progress"><div></div></div>`;
    els.transferList.prepend(item);
    pendingFiles[fileId] = {
      fileId, file, peer,
      bar: item.querySelector('.progress > div'),
      pct: item.querySelector('.pct'),
    };
    send({ type: 'file-offer', to: peer.id, fileId, name: file.name, size: file.size });
  }
}

// 收到文件请求 → 自动接收（自用模式）或弹条询问
function onFileOffer(msg) {
  incomingFilesSet(msg.fileId, msg);
  if (autoAcceptFiles) {
    historyStore.add('自动接收文件', `${msg.name} 来自 ${msg.fromName}`);
    addChat('sys', `自动接收来自 ${msg.fromName} 的文件「${msg.name}」(${fmtSize(msg.size)})…`);
    doAcceptFile(msg.fileId);
    return;
  }
  els.fileIncomingText.textContent = `📦 ${msg.fromName} 想发送文件「${msg.name}」(${fmtSize(msg.size)})`;
  els.fileAcceptBtn.dataset.fileId = msg.fileId;
  els.fileIncomingBar.classList.remove('hidden');
  historyStore.add('收到文件请求', `${msg.name} 来自 ${msg.fromName}`);
}
function incomingFilesSet(id, data) { filePCs[id] = { offer: data, chunks: [], received: 0, pc: null }; }

els.fileRejectBtn.onclick = () => {
  const fileId = els.fileAcceptBtn.dataset.fileId;
  const ctx = filePCs[fileId];
  if (ctx) { send({ type: 'file-reject', to: ctx.offer.from, fileId }); delete filePCs[fileId]; }
  els.fileIncomingBar.classList.add('hidden');
};

// 接收方确认接收：建好 PC 等对方 offer（手动点"接收"或自动接收都走这里）
function doAcceptFile(fileId) {
  const ctx = filePCs[fileId];
  els.fileIncomingBar.classList.add('hidden');
  if (!ctx) return;
  const offer = ctx.offer;

  const item = document.createElement('div');
  item.className = 'transfer-item';
  item.innerHTML = `
    <div class="tname">⇩ ${escapeHtml(offer.name)}</div>
    <div class="tinfo"><span>${fmtSize(offer.size)} · 来自 ${escapeHtml(offer.fromName)}</span><span class="pct">建立连接…</span></div>
    <div class="progress"><div></div></div>`;
  els.transferList.prepend(item);
  ctx.bar = item.querySelector('.progress > div');
  ctx.pct = item.querySelector('.pct');

  const fpc = new RTCPeerConnection(RTC_CONF);
  ctx.pc = fpc;
  fpc.onicecandidate = e => {
    if (e.candidate) send({ type: 'file-signal', to: offer.from, fileId, candidate: e.candidate });
  };
  fpc.ondatachannel = e => {
    const dc = e.channel;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = ev => {
      ctx.chunks.push(ev.data);
      ctx.received += ev.data.byteLength;
      const p = Math.min(100, Math.round(ctx.received / offer.size * 100));
      ctx.bar.style.width = p + '%';
      ctx.pct.textContent = p + '%';
      if (ctx.received >= offer.size) finishRecvFile(fileId);
    };
  };
  send({ type: 'file-accept', to: offer.from, fileId });
}
els.fileAcceptBtn.onclick = () => doAcceptFile(els.fileAcceptBtn.dataset.fileId);

// 发送方收到"接受"：建 PC + DataChannel，发 offer
async function onFileAccept(msg) {
  const ctx = pendingFiles[msg.fileId];
  if (!ctx) return;
  const fpc = new RTCPeerConnection(RTC_CONF);
  ctx.pc = fpc;
  fpc.onicecandidate = e => {
    if (e.candidate) send({ type: 'file-signal', to: ctx.peer.id, fileId: msg.fileId, candidate: e.candidate });
  };
  const dc = fpc.createDataChannel('file');
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 1048576;
  dc.onopen = () => sendFileChunks(ctx, dc);
  ctx.dc = dc;
  ctx.pct.textContent = '建立连接…';
  const offer = await fpc.createOffer();
  await fpc.setLocalDescription(offer);
  send({ type: 'file-signal', to: ctx.peer.id, fileId: msg.fileId, sdp: offer });
}

function onFileReject(msg) {
  const ctx = pendingFiles[msg.fileId];
  if (ctx) {
    ctx.pct.textContent = '对方拒收 ✕';
    ctx.pct.style.color = 'var(--danger)';
    delete pendingFiles[msg.fileId];
  }
  toast(`${msg.fromName || '对方'} 拒收了文件`);
}

// 文件传输专用信令（与通话 PC 隔离）
async function onFileSignal(msg) {
  const ctx = pendingFiles[msg.fileId] || filePCs[msg.fileId];
  if (!ctx || !ctx.pc) return;
  try {
    if (msg.sdp) {
      await ctx.pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === 'offer') {
        const ans = await ctx.pc.createAnswer();
        await ctx.pc.setLocalDescription(ans);
        send({ type: 'file-signal', to: msg.from, fileId: msg.fileId, sdp: ans });
      }
    } else if (msg.candidate) {
      await ctx.pc.addIceCandidate(msg.candidate);
    }
  } catch { /* 忽略信令时序异常 */ }
}

// 分块发送（带背压控制）
async function sendFileChunks(ctx, dc) {
  const { file } = ctx;
  const buf = await file.arrayBuffer();
  let offset = 0;
  while (offset < buf.byteLength) {
    if (dc.readyState !== 'open') return;
    if (dc.bufferedAmount > 4194304) {
      await new Promise(r => { dc.onbufferedamountlow = r; });
      continue;
    }
    const end = Math.min(offset + FILE_CHUNK, buf.byteLength);
    dc.send(buf.slice(offset, end));
    offset = end;
    const p = Math.round(offset / buf.byteLength * 100);
    ctx.bar.style.width = p + '%';
    ctx.pct.textContent = p + '%';
  }
  // 等缓冲区清空，确保最后一块送达
  await new Promise(r => {
    const t = setInterval(() => {
      if (dc.bufferedAmount === 0 || dc.readyState !== 'open') { clearInterval(t); r(); }
    }, 150);
  });
  ctx.pct.textContent = '已送达 ✓';
  toast(`已发送: ${file.name} → ${ctx.peer.name}`);
  historyStore.add('发送文件', `${file.name} (${fmtSize(file.size)}) → ${ctx.peer.name}`);
  addChat('sys', `已发送文件「${file.name}」给 ${ctx.peer.name}`);
  setTimeout(() => { try { ctx.pc.close(); } catch { } delete pendingFiles[ctx.fileId]; }, 3000);

  // 3.0 VIP：文件同时存入服务器缓存 10 分钟，房间内任何人可凭链接重复下载
  if (vipActive()) {
    const cached = await cacheToServer(file);
    if (cached) {
      const text = `文件「${file.name}」已存入服务器缓存（10 分钟内可重复下载）`;
      send({ type: 'chat', to: ctx.peer.id, text: `${text} ${cached}` });
      addChat('sys', `${text}（也可点击链接再次下载）`, cached);
      historyStore.add('文件缓存', file.name);
    }
  }
}

// 接收完成：拼 Blob 自动下载
function finishRecvFile(fileId) {
  const ctx = filePCs[fileId];
  if (!ctx) return;
  const offer = ctx.offer;
  const blob = new Blob(ctx.chunks);
  ctx.chunks = [];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = offer.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  ctx.pct.textContent = '已接收 ✓ 自动下载';
  toast(`收到文件: ${offer.name}，已自动下载`);
  addChat('sys', `收到来自 ${offer.fromName} 的文件「${offer.name}」(${fmtSize(offer.size)})，已自动下载`);
  historyStore.add('收到文件', `${offer.name} (${fmtSize(offer.size)}) 来自 ${offer.fromName}`);
  receivedMemFiles.unshift({ name: offer.name, size: offer.size, from: offer.fromName, time: Date.now() });
  renderRecvFiles();
  setTimeout(() => { try { ctx.pc.close(); } catch { } delete filePCs[fileId]; }, 3000);
}

// 断线时中止所有传输
function abortAllTransfers(reason) {
  for (const ctx of Object.values(pendingFiles)) {
    if (ctx.pct && !/✓|✕/.test(ctx.pct.textContent)) { ctx.pct.textContent = reason + ' ✕'; ctx.pct.style.color = 'var(--danger)'; }
    try { ctx.pc && ctx.pc.close(); } catch { }
  }
  for (const k of Object.keys(pendingFiles)) delete pendingFiles[k];
  for (const ctx of Object.values(filePCs)) {
    if (ctx.pct && !/✓|✕/.test(ctx.pct.textContent)) { ctx.pct.textContent = reason + ' ✕'; ctx.pct.style.color = 'var(--danger)'; }
    try { ctx.pc && ctx.pc.close(); } catch { }
  }
  for (const k of Object.keys(filePCs)) delete filePCs[k];
}

/* ================= 收到的文件（内存记录，P2P 直收自动下载） ================= */
function renderRecvFiles() {
  if (!receivedMemFiles.length) {
    els.recvList.innerHTML = '<li class="empty-tip">暂无收到的文件<br><small>P2P 直传：收到文件会自动下载到本机</small></li>';
    return;
  }
  els.recvList.innerHTML = receivedMemFiles.map(f => `
    <li class="recv-item">
      <span class="rname" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="rsize">${fmtSize(f.size)} · 来自 ${escapeHtml(f.from)} · ${fmtTime(f.time)}</span>
    </li>`).join('');
}
els.refreshFilesBtn.onclick = renderRecvFiles;

/* ================= 其他 ================= */
els.addrBox.onclick = () => {
  navigator.clipboard.writeText(els.addrValue.textContent).then(() => toast('分享地址已复制'));
};
els.roomSwitchBtn.onclick = switchRoom;
$('renameBtn').onclick = () => {
  const name = prompt('输入新的设备名称:', myName);
  if (name && name.trim()) {
    myName = name.trim();
    localStorage.setItem('lanhub_name', myName);
    els.myName.textContent = myName;
    send({ type: 'rename', name: myName });
    historyStore.add('修改设备名', myName);
  }
};

/* ================= 手机端 Tab 切换（桌面端三栏常显，不受影响） ================= */
function switchTab(name) {
  document.querySelectorAll('.mobile-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.panel[data-panel]').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
}
document.querySelectorAll('.mobile-tabs button').forEach(b => {
  b.onclick = () => switchTab(b.dataset.tab);
});

/* ================= 3.0 事件绑定 ================= */
bindGlossary();
if (els.exportChatBtn) els.exportChatBtn.onclick = exportChat;
if (els.anchorApplyBtn) els.anchorApplyBtn.onclick = () => {
  send({ type: 'anchor-apply' });
  toast('已提交主播申请，等待房主审批');
};
if (els.anchorLiveBtn) els.anchorLiveBtn.onclick = startAnchorLive;
if (els.anchorQuitBtn) els.anchorQuitBtn.onclick = quitAnchor;
if (els.anchorAllowBtn) els.anchorAllowBtn.onclick = () => answerAnchor(true);
if (els.anchorDenyBtn) els.anchorDenyBtn.onclick = () => answerAnchor(false);
if (els.anchorWatchToggle) {
  els.anchorWatchToggle.checked = localStorage.getItem('lanhub_anchorwatch') !== '0';
  els.anchorWatchToggle.onchange = e => {
    localStorage.setItem('lanhub_anchorwatch', e.target.checked ? '1' : '0');
    if (!e.target.checked) {
      subscribedAnchors.clear();
      for (const c of [...conns.values()]) {
        const p = peerList.find(x => x.id === c.id);
        if (c.mode === 'screen' && p && p.role === 'anchor') closeConn(c, '已关闭自动看主播');
      }
    } else scheduleAnchorSubscribe();
    toast(e.target.checked ? '已开启：进房自动观看正在直播的主播' : '已关闭：不再自动观看主播');
  };
} else {
  // 兜底：HTML 默认 checked，无元素时不影响逻辑
}
if (els.myType) {
  const dm = deviceMeta(detectDeviceType());
  els.myType.textContent = `${dm.icon} ${dm.label}`;
}
updateAnchorUI();

/* ================= 初始化 ================= */
// 使用指引：默认折叠，点击标题展开/收起，状态记忆
const helpTipEl = $('helpTip');
if (localStorage.getItem('lanhub_help') === '1') helpTipEl.classList.remove('collapsed');
$('helpTitle').onclick = () => {
  helpTipEl.classList.toggle('collapsed');
  localStorage.setItem('lanhub_help', helpTipEl.classList.contains('collapsed') ? '0' : '1');
};

(async function init() {
  // 房间码优先级：URL ?room= > localStorage > public 公共大厅
  const urlRoom = new URLSearchParams(location.search).get('room');
  myRoom = normalizeRoom(urlRoom || localStorage.getItem('lanhub_room') || 'public');
  localStorage.setItem('lanhub_room', myRoom);

  els.myName.textContent = myName;
  updateRoomUI();
  renderVipBadge();
  switchTab('devices');
  renderFootStats();
  loadProgramInfo();
  renderRecvFiles();
  try {
    const res = await fetch('/api/info');
    if (!res.ok) throw new Error('no local api');
    const info = await res.json();
    const addr = info.ips.length ? `http://${info.ips[0]}:${info.port}` : `http://localhost:${info.port}`;
    els.addrValue.textContent = addr;
    els.myIp.textContent = info.ips.join(' / ') || 'localhost';
  } catch {
    // 云端版：显示当前页面地址（带房间码）作为分享地址
    els.addrValue.textContent = buildShareUrl(myRoom);
    els.myIp.textContent = '云端版';
  }
  connect();
  // 3.0：APK 原生通道下默认开启屏幕待命（无需手选屏幕，进房即可被看）
  if (nativeBridge()) setTimeout(() => { startStandby().catch(() => {}); }, 1200);
  addChat('sys', (myRoom === 'public'
    ? '欢迎使用灵犀互传 3.0 商用版，当前在公共大厅，等待设备上线…'
    : `欢迎使用灵犀互传 3.0 商用版，当前在房间「${myRoom}」，仅同房间设备可见…`)
    + (vip ? ' VIP 已激活：声音/远控/多人/录制/文件缓存已解锁。' : ' 全部开关已默认开启，激活 VIP 解锁声音/远控/多人/录制/文件缓存。'));
})();
