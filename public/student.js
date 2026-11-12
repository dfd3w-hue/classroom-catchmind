// 학생 화면 로직
var socket = io();
var $ = function (id) { return document.getElementById(id); };

var state = null;
var offset = 0;
var myWord = "";
var timerHandle = null;
var joined = false;
var lastRound = -1;
var eraserOn = false;
var curColor = "#111111";
var curWidth = 6;

var board = CatchCanvas($("board"), {
  onSegment: function (seg) { socket.emit("draw", seg); }
});
board.setCanDraw(false);

// 입장 화면 초기값 (주소의 ?code=1234, 또는 새로고침 전 정보)
var params = new URLSearchParams(location.search);
if (params.get("code")) $("code").value = params.get("code");
var savedInfo = null;
try { savedInfo = JSON.parse(sessionStorage.getItem("cm_student") || "null"); } catch (e) {}
if (savedInfo) {
  $("code").value = savedInfo.code;
  $("name").value = savedInfo.name;
}

function showJoin() {
  $("gameScreen").classList.add("hidden");
  $("joinScreen").classList.remove("hidden");
}
function showGame() {
  $("joinScreen").classList.add("hidden");
  $("gameScreen").classList.remove("hidden");
  board.resize();
}

function join(code, name) {
  socket.emit("student:join", { code: code, name: name }, function (res) {
    if (!res || !res.ok) {
      $("joinError").textContent = (res && res.error) || "입장할 수 없습니다.";
      sessionStorage.removeItem("cm_student");
      joined = false;
      showJoin();
      return;
    }
    sessionStorage.setItem("cm_student", JSON.stringify({ code: code, name: name }));
    $("joinError").textContent = "";
    joined = true;
    showGame();
  });
}

$("joinForm").addEventListener("submit", function (e) {
  e.preventDefault();
  join($("code").value.trim(), $("name").value.trim());
});

socket.on("connect", function () {
  var s = null;
  try { s = JSON.parse(sessionStorage.getItem("cm_student") || "null"); } catch (e) {}
  if (s) join(s.code, s.name);
});
socket.on("disconnect", function () { toast("서버와 연결이 끊겼습니다. 다시 연결 중..."); });
socket.on("kicked", function () {
  sessionStorage.removeItem("cm_student");
  joined = false;
  showJoin();
  $("joinError").textContent = "선생님이 방에서 내보냈습니다.";
});

socket.on("state", function (s) {
  state = s;
  offset = s.now - Date.now();
  render();
});
socket.on("strokes", function (list) { board.setAll(list); });
socket.on("draw", function (seg) { board.addRemote(seg); });
socket.on("undo", function (id) { board.removeStroke(id); });
socket.on("clear", function () { board.clear(); });
socket.on("your:word", function (w) {
  myWord = w;
  $("myWord").textContent = w;
});

function hide(id) { $(id).classList.add("hidden"); }
function show(id) { $(id).classList.remove("hidden"); }

function render() {
  if (!state || !joined) return;
  var me = state.players[socket.id];
  if (!me) return;

  $("myName").textContent = me.name;
  $("myScore").textContent = me.score + "점";
  $("roundLabel").textContent = state.round ? state.round + "라운드" : "";

  var isDrawer = state.drawerId === socket.id;

  // 새 라운드가 시작되면 입력창 초기화
  if (state.round !== lastRound) {
    lastRound = state.round;
    $("answer").value = "";
    eraserOn = false;
    updateToolUI();
  }

  hide("waitBox"); hide("drawerBox"); hide("guessBox"); hide("resultBox");

  if (state.status === "waiting") {
    myWord = "";
    show("waitBox");
    board.setCanDraw(false);
  } else if (state.status === "drawing") {
    if (isDrawer) {
      show("drawerBox");
      $("myWord").textContent = myWord || "...";
      board.setCanDraw(true);
    } else {
      show("guessBox");
      $("drawerName").textContent = state.drawerName || "";
      $("answerStatus").textContent = me.answered
        ? "제출 완료! (시간 안에 다시 제출하면 수정됩니다)"
        : "아직 제출하지 않았습니다.";
      board.setCanDraw(false);
    }
  } else {
    board.setCanDraw(false);
    var r = state.lastResult;
    if (r) {
      show("resultBox");
      $("rWord").textContent = r.word;
      var mineEl = $("rMine");
      mineEl.className = "mine";
      if (isDrawer) {
        mineEl.textContent = "내가 출제자였습니다. 정답 " + r.correctCount + "명 → 보너스 +" + r.drawerBonus + "점";
      } else {
        var mine = null;
        for (var i = 0; i < r.results.length; i++) if (r.results[i].id === socket.id) mine = r.results[i];
        if (mine && mine.correct) {
          mineEl.textContent = "정답! 내 답: " + mine.answer + " (+10점)";
          mineEl.className = "mine ok";
        } else {
          mineEl.textContent = "아쉽네요. 내 답: " + (mine && mine.answer ? mine.answer : "(미제출)");
          mineEl.className = "mine bad";
        }
      }
      var ol = $("scoreboard");
      ol.innerHTML = "";
      Object.keys(state.players)
        .sort(function (a, b) { return state.players[b].score - state.players[a].score; })
        .forEach(function (id) {
          var p = state.players[id];
          var li = document.createElement("li");
          li.className = id === socket.id ? "me-row" : "";
          li.innerHTML = "<span>" + esc(p.name) + (p.connected ? "" : ' <span class="muted">(끊김)</span>') + "</span><span>" + p.score + "점</span>";
          ol.appendChild(li);
        });
    } else {
      show("waitBox");
    }
  }
  startTimer();
}

function startTimer() {
  clearInterval(timerHandle);
  var el = $("timer");
  if (state.status !== "drawing" || !state.endsAt) {
    el.textContent = "--:--";
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

// 정답 제출
$("answerForm").addEventListener("submit", function (e) {
  e.preventDefault();
  var text = $("answer").value.trim();
  if (!text) return;
  socket.emit("student:answer", text, function (res) {
    if (res && res.ok) {
      toast("제출했습니다. 결과는 라운드가 끝나면 공개됩니다.");
    } else {
      toast("지금은 제출할 수 없습니다.");
    }
  });
});

// 출제자 도구
var COLORS = ["#111111", "#dc2626", "#f97316", "#eab308", "#16a34a", "#2563eb", "#7c3aed", "#92400e"];
var colorsEl = $("colors");
COLORS.forEach(function (c) {
  var b = document.createElement("button");
  b.type = "button";
  b.className = "swatch" + (c === curColor ? " active" : "");
  b.style.background = c;
  b.dataset.c = c;
  b.addEventListener("click", function () {
    curColor = c;
    eraserOn = false;
    updateToolUI();
  });
  colorsEl.appendChild(b);
});
Array.prototype.forEach.call(document.querySelectorAll(".widths button"), function (b) {
  b.type = "button";
  b.addEventListener("click", function () {
    curWidth = parseInt(b.dataset.w, 10);
    eraserOn = false;
    updateToolUI();
  });
});
$("eraser").addEventListener("click", function () {
  eraserOn = !eraserOn;
  updateToolUI();
});
$("undo").addEventListener("click", function () {
  var id = board.undoLocal();
  if (id) socket.emit("undo", id);
});
$("clearBtn").addEventListener("click", function () {
  if (confirm("그림을 전부 지울까요?")) socket.emit("clear");
});

function updateToolUI() {
  Array.prototype.forEach.call(colorsEl.children, function (b) {
    b.classList.toggle("active", !eraserOn && b.dataset.c === curColor);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".widths button"), function (b) {
    b.classList.toggle("active", parseInt(b.dataset.w, 10) === curWidth);
  });
  $("eraser").classList.toggle("active", eraserOn);
  if (eraserOn) {
    board.setColor("#ffffff");
    board.setWidth(30);
  } else {
    board.setColor(curColor);
    board.setWidth(curWidth);
  }
}
updateToolUI();
