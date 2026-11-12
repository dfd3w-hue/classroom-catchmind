// 교사 화면 로직
var socket = io();
var $ = function (id) { return document.getElementById(id); };

var state = null;
var offset = 0;          // 서버 시간 - 내 시간 (타이머 동기화용)
var selectedDrawer = null;
var timerHandle = null;
var wordHidden = false;
var currentWord = "";
var prevStatus = null;

var board = CatchCanvas($("board"), {});
board.setCanDraw(false);

// 서버 정보 (제시어 범주, 접속 주소)
fetch("/api/info")
  .then(function (r) { return r.json(); })
  .then(function (info) {
    var sel = $("category");
    info.categories.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    });
    var urls = [];
    var host = location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      info.ips.forEach(function (ip) {
        urls.push("http://" + ip + ":" + info.port + "/student.html");
      });
    } else {
      urls.push(location.origin + "/student.html");
    }
    $("joinUrl").innerHTML = urls.length
      ? urls.map(function (u) { return "<div>" + esc(u) + "</div>"; }).join("")
      : "<div>네트워크 주소를 찾을 수 없습니다.</div>";
  })
  .catch(function () {
    $("joinUrl").textContent = location.origin + "/student.html";
  });

// 방 만들기 / 새로고침 후 다시 들어가기
socket.on("connect", function () {
  var saved = sessionStorage.getItem("cm_teacher_code");
  var create = function () {
    socket.emit("teacher:create", function (res) {
      if (res && res.ok) sessionStorage.setItem("cm_teacher_code", res.code);
    });
  };
  if (saved) {
    socket.emit("teacher:rejoin", saved, function (res) {
      if (!res || !res.ok) create();
    });
  } else {
    create();
  }
});

socket.on("state", function (s) {
  state = s;
  offset = s.now - Date.now();
  if (prevStatus === "drawing" && s.status === "finished") {
    selectedDrawer = nextDrawer(s);
  }
  prevStatus = s.status;
  render();
});
socket.on("strokes", function (list) { board.setAll(list); });
socket.on("draw", function (seg) { board.addRemote(seg); });
socket.on("undo", function (id) { board.removeStroke(id); });
socket.on("clear", function () { board.clear(); });
socket.on("teacher:word", function (w) { currentWord = w; renderWord(); });
socket.on("toast", function (msg) { toast(msg); });
socket.on("disconnect", function () { toast("서버와 연결이 끊겼습니다. 다시 연결 중..."); });

function connectedIds(s) {
  return Object.keys(s.players).filter(function (id) { return s.players[id].connected; });
}

// 라운드가 끝나면 다음 학생을 출제자로 미리 선택 (순서대로 돌아가기)
function nextDrawer(s) {
  var ids = Object.keys(s.players).sort(function (a, b) {
    return s.players[a].name.localeCompare(s.players[b].name);
  });
  var conn = ids.filter(function (id) { return s.players[id].connected; });
  if (!conn.length) return null;
  var idx = ids.indexOf(s.drawerId);
  for (var k = 1; k <= ids.length; k++) {
    var cand = ids[(idx + k) % ids.length];
    if (s.players[cand].connected) return cand;
  }
  return conn[0];
}

function render() {
  if (!state) return;
  $("code").textContent = state.code;
  var statusMap = {
    waiting: state.round ? state.round + "라운드 종료 · 대기 중" : "대기 중",
    drawing: state.round + "라운드 진행 중",
    finished: state.round + "라운드 결과"
  };
  $("statusText").textContent = statusMap[state.status] || state.status;

  var ids = Object.keys(state.players);
  var connected = connectedIds(state);
  $("playerCount").textContent = connected.length;
  if (selectedDrawer && !(state.players[selectedDrawer] && state.players[selectedDrawer].connected)) {
    selectedDrawer = null;
  }

  var ul = $("players");
  ul.innerHTML = "";
  ids.sort(function (a, b) {
    return state.players[b].score - state.players[a].score ||
      state.players[a].name.localeCompare(state.players[b].name);
  });
  ids.forEach(function (id) {
    var p = state.players[id];
    var li = document.createElement("li");
    li.className = "player" +
      (p.connected ? "" : " offline") +
      (id === selectedDrawer ? " selected" : "") +
      (id === state.drawerId && state.status === "drawing" ? " drawer" : "");
    var badges = "";
    if (id === state.drawerId && state.status !== "waiting") badges += '<span class="badge">출제자</span>';
    if (p.answered && state.status === "drawing") badges += '<span class="badge ok">제출</span>';
    if (!p.connected) badges += '<span class="badge off">접속 끊김</span>';
    li.innerHTML =
      '<span class="pname">' + esc(p.name) + "</span>" +
      '<span class="badges">' + badges + "</span>" +
      '<span class="score">' + p.score + "점</span>" +
      '<button class="kick" title="내보내기">×</button>';
    li.addEventListener("click", function (e) {
      if (e.target.classList.contains("kick")) {
        if (confirm(p.name + " 학생을 방에서 내보낼까요?")) socket.emit("teacher:kick", id);
        return;
      }
      if (p.connected && state.status !== "drawing") {
        selectedDrawer = id;
        render();
      }
    });
    ul.appendChild(li);
  });

  var guessers = connected.filter(function (id) { return id !== state.drawerId; });
  var answered = guessers.filter(function (id) { return state.players[id].answered; }).length;
  $("answerCount").textContent = state.status === "drawing"
    ? "정답 제출 " + answered + " / " + guessers.length + "명"
    : "참여 " + connected.length + "명";

  if (state.status === "drawing") {
    $("drawerLine").textContent = "출제자: " + (state.drawerName || "-") + " 학생이 그리는 중";
  } else if (selectedDrawer) {
    $("drawerLine").textContent = "다음 출제자: " + state.players[selectedDrawer].name + " (라운드 시작을 누르세요)";
  } else {
    $("drawerLine").textContent = connected.length
      ? "학생 이름을 눌러 출제자를 선택하세요"
      : "학생들이 입장하기를 기다리는 중입니다";
  }

  $("start").disabled = state.status === "drawing" || !selectedDrawer;
  $("end").disabled = state.status !== "drawing";

  if (state.status === "waiting") currentWord = "";
  renderWord();
  startTimer();

  if (state.status === "finished" && state.lastResult) showResult(state.lastResult);
  else $("result").classList.add("hidden");
}

function renderWord() {
  var el = $("word");
  if (!currentWord) {
    el.textContent = "-";
    $("toggleWord").style.visibility = "hidden";
    return;
  }
  $("toggleWord").style.visibility = "visible";
  el.textContent = wordHidden ? "●●●" : currentWord;
  $("toggleWord").textContent = wordHidden ? "보이기" : "숨기기";
}

function startTimer() {
  clearInterval(timerHandle);
  var el = $("timer");
  if (state.status !== "drawing" || !state.endsAt) {
    el.textContent = state.status === "waiting" ? fmtTime(parseInt($("seconds").value, 10) || 60) : "00:00";
    el.classList.remove("urgent");
    return;
  }
  var tick = function () {
    var ms = Math.max(0, state.endsAt - (Date.now() + offset));
    el.textContent = fmtTime(Math.ceil(ms / 1000));
    el.classList.toggle("urgent", ms <= 10000);
    if (ms <= 0) clearInterval(timerHandle);
  };
  tick();
  timerHandle = setInterval(tick, 200);
}

function showResult(r) {
  $("resultWord").textContent = r.word;
  var meta = "출제자 " + r.drawerName + " · 정답 " + r.correctCount + "명 · 출제자 보너스 +" + r.drawerBonus + "점";
  if (r.reason === "teacher") meta += " · 선생님이 종료";
  if (r.reason === "drawer-left") meta += " · 출제자 퇴장으로 종료";
  $("resultMeta").textContent = meta;
  var tb = $("resultBody");
  tb.innerHTML = "";
  var rows = r.results.slice().sort(function (a, b) {
    return (b.correct - a.correct) || a.name.localeCompare(b.name);
  });
  rows.forEach(function (x) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(x.name) + "</td>" +
      "<td>" + (x.answer ? esc(x.answer) : '<span class="muted">(미제출)</span>') + "</td>" +
      "<td>" + (x.correct ? '<span class="badge ok">정답</span>' : '<span class="badge bad">오답</span>') + "</td>";
    tb.appendChild(tr);
  });
  if (!rows.length) tb.innerHTML = '<tr><td colspan="3" class="muted">제출한 학생이 없습니다.</td></tr>';
  $("result").classList.remove("hidden");
}

// 버튼
$("randomDrawer").addEventListener("click", function () {
  if (!state) return;
  var c = connectedIds(state);
  if (!c.length) return toast("참여한 학생이 없습니다.");
  selectedDrawer = c[Math.floor(Math.random() * c.length)];
  render();
});
$("start").addEventListener("click", function () {
  if (!selectedDrawer) return toast("출제자를 먼저 선택하세요.");
  socket.emit("teacher:startRound", {
    drawerId: selectedDrawer,
    seconds: $("seconds").value,
    category: $("category").value,
    customWord: $("customWord").value
  });
  $("customWord").value = "";
});
$("end").addEventListener("click", function () { socket.emit("teacher:endRound"); });
$("clear").addEventListener("click", function () { socket.emit("clear"); });
$("reset").addEventListener("click", function () {
  if (confirm("모든 학생의 점수를 0점으로 초기화할까요?")) socket.emit("teacher:resetScores");
});
$("newRoom").addEventListener("click", function () {
  if (confirm("새 방을 만들면 현재 방 번호와 점수가 사라집니다. 계속할까요?")) {
    sessionStorage.removeItem("cm_teacher_code");
    location.reload();
  }
});
$("toggleWord").addEventListener("click", function () {
  wordHidden = !wordHidden;
  renderWord();
});
$("next").addEventListener("click", function () { socket.emit("teacher:nextRound"); });
$("seconds").addEventListener("change", function () { if (state) startTimer(); });
