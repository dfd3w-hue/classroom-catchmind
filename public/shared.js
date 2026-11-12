// 교사/학생 공용: 캔버스 그리기 + 유틸
(function () {
  var BASE_W = 800; // 선 굵기 기준 폭 (화면 크기가 달라도 같은 비율로 보이게)

  window.CatchCanvas = function (canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext("2d");
    var segments = [];
    var canDraw = false;
    var color = "#111111";
    var width = 6;
    var drawing = false;
    var last = null;
    var strokeId = null;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      redraw();
    }

    function drawSeg(s) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * (canvas.width / BASE_W);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s.x0 * canvas.width, s.y0 * canvas.height);
      ctx.lineTo(s.x1 * canvas.width, s.y1 * canvas.height);
      ctx.stroke();
    }

    function redraw() {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < segments.length; i++) drawSeg(segments[i]);
    }

    function clamp(v) {
      return Math.min(1, Math.max(0, v));
    }

    function pos(e) {
      var r = canvas.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
    }

    function newId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function pushLocal(seg) {
      segments.push(seg);
      drawSeg(seg);
      if (opts.onSegment) opts.onSegment(seg);
    }

    canvas.addEventListener("pointerdown", function (e) {
      if (!canDraw) return;
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      drawing = true;
      last = pos(e);
      strokeId = newId();
      // 점 하나만 찍어도 보이도록 아주 짧은 선을 그림
      pushLocal({ id: strokeId, x0: last.x, y0: last.y, x1: last.x + 0.0005, y1: last.y, color: color, width: width });
    });

    canvas.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      e.preventDefault();
      var p = pos(e);
      pushLocal({ id: strokeId, x0: last.x, y0: last.y, x1: p.x, y1: p.y, color: color, width: width });
      last = p;
    });

    function stop() {
      drawing = false;
    }
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("pointerleave", stop);

    window.addEventListener("resize", resize);
    resize();

    return {
      resize: resize,
      setCanDraw: function (v) {
        canDraw = !!v;
        canvas.classList.toggle("drawable", canDraw);
      },
      setColor: function (c) { color = c; },
      setWidth: function (w) { width = w; },
      addRemote: function (seg) {
        segments.push(seg);
        drawSeg(seg);
      },
      setAll: function (list) {
        segments = (list || []).slice();
        redraw();
      },
      removeStroke: function (id) {
        segments = segments.filter(function (s) { return s.id !== id; });
        redraw();
      },
      undoLocal: function () {
        if (!segments.length) return null;
        var id = segments[segments.length - 1].id;
        segments = segments.filter(function (s) { return s.id !== id; });
        redraw();
        return id;
      },
      clear: function () {
        segments = [];
        redraw();
      }
    };
  };

  window.fmtTime = function (sec) {
    sec = Math.max(0, sec | 0);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
  };

  window.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  var toastTimer = null;
  window.toast = function (msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 2500);
  };
})();
