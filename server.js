// 교실 캐치마인드 서버 (Node.js + Express + Socket.IO)
const path = require("path");
const os = require("os");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const WORDS = require("./words.json");

const PORT = process.env.PORT || 3000;
const MAX_SEGMENTS = 30000;      // 한 라운드에 저장하는 최대 선분 수
const ROOM_TTL_MS = 30 * 60 * 1000; // 아무도 없는 방을 지우기까지의 시간

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/api/info", (req, res) => {
  res.json({ port: PORT, ips: lanIps(), categories: Object.keys(WORDS) });
});

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const rooms = {};

function genCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[code]);
  return code;
}

function norm(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

function newRoom(teacherId) {
  const code = genCode();
  const room = {
    code,
    teacherId,
    players: {},     // socketId -> { name, score, connected }
    status: "waiting", // waiting | drawing | finished
    round: 0,
    drawerId: null,
    word: null,
    seconds: 60,
    endsAt: null,
    answers: {},     // socketId -> 제출한 답 (마감 전까지 비공개)
    strokes: [],     // 그림 선분 목록 (늦게 들어온 사람에게 다시 그려줌)
    timer: null,
    lastResult: null,
    cleanup: null
  };
  rooms[code] = room;
  return room;
}

function publicState(room) {
  const players = {};
  for (const [id, p] of Object.entries(room.players)) {
    players[id] = {
      name: p.name,
      score: p.score,
      connected: p.connected,
      answered: room.answers[id] !== undefined
    };
  }
  const drawer = room.players[room.drawerId];
  return {
    code: room.code,
    status: room.status,
    round: room.round,
    drawerId: room.drawerId,
    drawerName: drawer ? drawer.name : null,
    endsAt: room.endsAt,
    seconds: room.seconds,
    players,
    lastResult: room.lastResult,
    now: Date.now()
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", publicState(room));
}

function scheduleCleanup(room) {
  const sockets = io.sockets.adapter.rooms.get(room.code);
  if (sockets && sockets.size > 0) return;
  clearTimeout(room.cleanup);
  room.cleanup = setTimeout(() => {
    clearTimeout(room.timer);
    delete rooms[room.code];
    console.log(`[room ${room.code}] 삭제됨 (비어 있음)`);
  }, ROOM_TTL_MS);
}

function pickWord(category, custom) {
  if (custom && String(custom).trim()) return String(custom).trim().slice(0, 30);
  const list = WORDS[category] || Object.values(WORDS).flat();
  return list[Math.floor(Math.random() * list.length)];
}

function endRound(room, reason) {
  clearTimeout(room.timer);
  room.timer = null;
  if (room.status !== "drawing") return;
  room.status = "finished";
  room.endsAt = null;

  const results = [];
  let correctCount = 0;
  for (const [id, p] of Object.entries(room.players)) {
    if (id === room.drawerId) continue;
    const ans = room.answers[id];
    if (!p.connected && ans === undefined) continue;
    const correct = ans !== undefined && ans !== "" && norm(ans) === norm(room.word);
    if (correct) {
      p.score += 10;
      correctCount++;
    }
    results.push({ id, name: p.name, answer: ans === undefined ? "" : ans, correct });
  }
  const drawer = room.players[room.drawerId];
  const drawerBonus = correctCount * 5;
  if (drawer) drawer.score += drawerBonus;

  room.lastResult = {
    word: room.word,
    drawerName: drawer ? drawer.name : "",
    results,
    correctCount,
    drawerBonus,
    reason
  };
  console.log(`[room ${room.code}] ${room.round}라운드 종료 (${reason}) 정답 ${correctCount}명`);
  broadcast(room);
}

io.on("connection", (socket) => {
  const getRoom = () => rooms[socket.data.code];
  const isTeacher = (room) => !!room && room.teacherId === socket.id;

  // ---------- 교사 ----------
  socket.on("teacher:create", (cb) => {
    const room = newRoom(socket.id);
    socket.join(room.code);
    socket.data.code = room.code;
    socket.data.role = "teacher";
    console.log(`[room ${room.code}] 생성`);
    if (cb) cb({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on("teacher:rejoin", (code, cb) => {
    const room = rooms[String(code)];
    if (!room) {
      if (cb) cb({ ok: false });
      return;
    }
    clearTimeout(room.cleanup);
    room.teacherId = socket.id;
    socket.join(room.code);
    socket.data.code = room.code;
    socket.data.role = "teacher";
    if (cb) cb({ ok: true, code: room.code });
    socket.emit("strokes", room.strokes);
    if (room.status === "drawing" && room.word) socket.emit("teacher:word", room.word);
    broadcast(room);
  });

  socket.on("teacher:startRound", (opts) => {
    const room = getRoom();
    if (!isTeacher(room) || room.status === "drawing") return;
    opts = opts || {};
    const drawer = room.players[opts.drawerId];
    if (!drawer || !drawer.connected) {
      socket.emit("toast", "출제자를 먼저 선택하세요.");
      return;
    }
    clearTimeout(room.timer);
    room.round += 1;
    room.drawerId = opts.drawerId;
    room.word = pickWord(opts.category, opts.customWord);
    room.seconds = Math.min(600, Math.max(10, parseInt(opts.seconds, 10) || 60));
    room.answers = {};
    room.strokes = [];
    room.lastResult = null;
    room.status = "drawing";
    room.endsAt = Date.now() + room.seconds * 1000;
    room.timer = setTimeout(() => endRound(room, "time"), room.seconds * 1000);

    io.to(room.code).emit("clear");
    io.to(room.drawerId).emit("your:word", room.word); // 출제자에게만 제시어
    socket.emit("teacher:word", room.word);            // 교사에게도 제시어
    console.log(`[room ${room.code}] ${room.round}라운드 시작 - 출제자 ${drawer.name}, 제시어 ${room.word}`);
    broadcast(room);
  });

  socket.on("teacher:endRound", () => {
    const room = getRoom();
    if (isTeacher(room) && room.status === "drawing") endRound(room, "teacher");
  });

  socket.on("teacher:nextRound", () => {
    const room = getRoom();
    if (!isTeacher(room)) return;
    room.status = "waiting";
    room.lastResult = null;
    room.endsAt = null;
    broadcast(room);
  });

  socket.on("teacher:resetScores", () => {
    const room = getRoom();
    if (!isTeacher(room)) return;
    clearTimeout(room.timer);
    for (const p of Object.values(room.players)) p.score = 0;
    room.status = "waiting";
    room.round = 0;
    room.lastResult = null;
    room.endsAt = null;
    room.answers = {};
    room.strokes = [];
    io.to(room.code).emit("clear");
    broadcast(room);
  });

  socket.on("teacher:kick", (id) => {
    const room = getRoom();
    if (!isTeacher(room) || !room.players[id]) return;
    delete room.players[id];
    delete room.answers[id];
    const target = io.sockets.sockets.get(id);
    if (target) {
      target.leave(room.code);
      target.data.code = null;
      target.emit("kicked");
    }
    if (room.drawerId === id && room.status === "drawing") endRound(room, "drawer-left");
    broadcast(room);
  });

  // ---------- 학생 ----------
  socket.on("student:join", (payload, cb) => {
    payload = payload || {};
    const code = String(payload.code || "").trim();
    const name = String(payload.name || "").trim().slice(0, 12);
    const room = rooms[code];
    if (!room) {
      if (cb) cb({ ok: false, error: "방 번호가 올바르지 않습니다." });
      return;
    }
    if (!name) {
      if (cb) cb({ ok: false, error: "이름을 입력하세요." });
      return;
    }
    clearTimeout(room.cleanup);

    // 같은 이름으로 접속이 끊긴 학생이 있으면 점수를 이어받음 (새로고침/재접속)
    const oldId = Object.keys(room.players).find(
      (id) => room.players[id].name === name && !room.players[id].connected
    );
    if (oldId) {
      room.players[socket.id] = Object.assign({}, room.players[oldId], { connected: true });
      delete room.players[oldId];
      if (room.answers[oldId] !== undefined) {
        room.answers[socket.id] = room.answers[oldId];
        delete room.answers[oldId];
      }
      if (room.drawerId === oldId) room.drawerId = socket.id;
    } else {
      const dup = Object.values(room.players).some((p) => p.name === name && p.connected);
      if (dup) {
        if (cb) cb({ ok: false, error: "이미 같은 이름의 학생이 있습니다. 다른 이름을 쓰세요." });
        return;
      }
      room.players[socket.id] = { name, score: 0, connected: true };
    }

    socket.join(code);
    socket.data.code = code;
    socket.data.role = "student";
    if (cb) cb({ ok: true, code });
    socket.emit("strokes", room.strokes);
    if (room.status === "drawing" && room.drawerId === socket.id) socket.emit("your:word", room.word);
    broadcast(room);
  });

  socket.on("student:answer", (text, cb) => {
    const room = getRoom();
    if (!room || room.status !== "drawing" || socket.data.role !== "student" || socket.id === room.drawerId) {
      if (cb) cb({ ok: false });
      return;
    }
    room.answers[socket.id] = String(text || "").trim().slice(0, 40);
    if (cb) cb({ ok: true });
    broadcast(room);
  });

  // ---------- 그림 ----------
  socket.on("draw", (seg) => {
    const room = getRoom();
    if (!room || room.status !== "drawing" || room.drawerId !== socket.id) return;
    if (!seg || typeof seg.x0 !== "number") return;
    const clean = {
      id: String(seg.id || "").slice(0, 24),
      x0: +seg.x0, y0: +seg.y0, x1: +seg.x1, y1: +seg.y1,
      color: /^#[0-9a-fA-F]{6}$/.test(seg.color) ? seg.color : "#111111",
      width: Math.min(60, Math.max(1, +seg.width || 5))
    };
    if (room.strokes.length < MAX_SEGMENTS) room.strokes.push(clean);
    socket.to(room.code).emit("draw", clean);
  });

  socket.on("undo", (id) => {
    const room = getRoom();
    if (!room || room.status !== "drawing" || room.drawerId !== socket.id) return;
    room.strokes = room.strokes.filter((s) => s.id !== id);
    socket.to(room.code).emit("undo", id);
  });

  socket.on("clear", () => {
    const room = getRoom();
    if (!room) return;
    if (!(isTeacher(room) || room.drawerId === socket.id)) return;
    room.strokes = [];
    io.to(room.code).emit("clear");
  });

  socket.on("disconnect", () => {
    const room = getRoom();
    if (!room) return;
    if (room.players[socket.id]) room.players[socket.id].connected = false;
    broadcast(room);
    scheduleCleanup(room);
  });
});

server.listen(PORT, () => {
  console.log("교실 캐치마인드 서버 실행 중");
  console.log(`  교사 화면 : http://localhost:${PORT}/teacher.html`);
  for (const ip of lanIps()) {
    console.log(`  학생 접속 : http://${ip}:${PORT}/student.html`);
  }
});
