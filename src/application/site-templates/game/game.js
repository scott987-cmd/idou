// 贪吃蛇 · 全部逻辑就在这一个文件里
//
// 这是个能直接玩的骨架。要做自己的游戏，把 step() 和 paint() 换掉就行：
// 上面那层（开始／暂停／计分／最高分／键盘和触屏输入）不用动。
// 最高分存在这台电脑的浏览器里，不会上传到任何地方。
(function () {
  "use strict";
  var CELLS = 20;                 // 棋盘是 20 × 20 格
  var TICK = 110;                 // 每一步多少毫秒，越小越快
  var BEST_KEY = "snake-best";

  var canvas = document.getElementById("board");
  var context = canvas.getContext("2d");
  var size = canvas.width / CELLS;
  var scoreOut = document.getElementById("score");
  var bestOut = document.getElementById("best");
  var curtain = document.getElementById("curtain");
  var message = document.getElementById("message");

  var snake, direction, queued, food, score, best, timer, running;

  // localStorage 在隐私窗口里会抛错，所以每一次都要兜住。
  function readBest() { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch (error) { return 0; } }
  function writeBest(value) { try { localStorage.setItem(BEST_KEY, String(value)); } catch (error) { /* 记不住就算了 */ } }

  function reset() {
    snake = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
    direction = { x: 1, y: 0 };
    queued = null;
    score = 0;
    placeFood();
    scoreOut.textContent = "0";
  }

  function placeFood() {
    do {
      food = { x: Math.floor(Math.random() * CELLS), y: Math.floor(Math.random() * CELLS) };
    } while (snake.some(function (part) { return part.x === food.x && part.y === food.y; }));
  }

  function step() {
    if (queued) { direction = queued; queued = null; }
    var head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };
    var hitWall = head.x < 0 || head.y < 0 || head.x >= CELLS || head.y >= CELLS;
    var hitSelf = snake.some(function (part) { return part.x === head.x && part.y === head.y; });
    if (hitWall || hitSelf) return over();
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score += 1;
      scoreOut.textContent = String(score);
      if (score > best) { best = score; bestOut.textContent = String(best); writeBest(best); }
      placeFood();
    } else {
      snake.pop();
    }
    paint();
  }

  function paint() {
    var styles = getComputedStyle(document.documentElement);
    context.fillStyle = styles.getPropertyValue("--paper").trim() || "#121a22";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = styles.getPropertyValue("--food").trim() || "#fb7185";
    round(food.x * size + 3, food.y * size + 3, size - 6, (size - 6) / 2);

    var accent = styles.getPropertyValue("--accent").trim() || "#34d399";
    snake.forEach(function (part, index) {
      context.globalAlpha = index === 0 ? 1 : Math.max(0.42, 1 - index * 0.035);
      context.fillStyle = accent;
      round(part.x * size + 2, part.y * size + 2, size - 4, index === 0 ? 7 : 5);
    });
    context.globalAlpha = 1;
  }

  function round(x, y, side, radius) {
    context.beginPath();
    if (context.roundRect) context.roundRect(x, y, side, side, radius);
    else context.rect(x, y, side, side);
    context.fill();
  }

  function start() {
    reset();
    paint();
    curtain.hidden = true;
    running = true;
    clearInterval(timer);
    timer = setInterval(step, TICK);
  }

  function pause() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    message.textContent = "暂停了";
    document.getElementById("start").textContent = "继续";
    curtain.hidden = false;
  }

  function resume() {
    running = true;
    curtain.hidden = true;
    clearInterval(timer);
    timer = setInterval(step, TICK);
  }

  function over() {
    running = false;
    clearInterval(timer);
    message.textContent = "撞到了 · 得分 " + score;
    document.getElementById("start").textContent = "再来一局";
    curtain.hidden = false;
  }

  function turn(name) {
    var next = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[name];
    if (!next) return;
    // 不能直接掉头：那等于立刻撞到自己。
    if (next.x === -direction.x && next.y === -direction.y) return;
    queued = next;
  }

  var KEYS = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right",
  };
  document.addEventListener("keydown", function (event) {
    if (event.key === " ") {
      event.preventDefault();
      if (!running && curtain.hidden === false) { document.getElementById("start").click(); }
      else { pause(); }
      return;
    }
    var name = KEYS[event.key];
    if (!name) return;
    event.preventDefault();
    if (running) turn(name);
  });
  document.querySelectorAll(".pad button").forEach(function (button) {
    button.addEventListener("click", function () { if (running) turn(button.dataset.dir); });
  });
  document.getElementById("start").addEventListener("click", function () {
    if (!running && snake && score >= 0 && document.getElementById("start").textContent === "继续") resume();
    else start();
  });

  best = readBest();
  bestOut.textContent = String(best);
  reset();
  paint();
})();
