// 项目进度 · 页面逻辑
//
// 把记录按「状态」那一列分成几列，一条记录一张卡。数据从 Table 拿
// （data/table.js）。表格里的内容是别人写的，所以一律用 textContent 放进页面，
// 永远不要拼 innerHTML。
(function () {
  "use strict";
  var OTHER = "未分组";
  var fields = Table.fields();
  var q = document.getElementById("q");
  var board = document.getElementById("board");
  var empty = document.getElementById("empty");
  var count = document.getElementById("count");
  var grouping = null;

  function text(node, value) { node.textContent = value == null ? "" : String(value); return node; }
  function make(tag, value, className) {
    var node = document.createElement(tag);
    if (value !== undefined) text(node, value);
    if (className) node.className = className;
    return node;
  }

  // 哪一列当泳道。和别的模版同一条规矩：**有值的每一行都各不相同的列是名字，
  // 不是分类**，按它分列等于一条记录一列。单选字段优先，同级里取值越少越好分。
  function chooseGrouping() {
    var rows = Table.rows(), best = null;
    fields.forEach(function (field, index) {
      if (index === 0) return;                       // 第一列是卡片标题
      if (field.kind !== "option" && field.kind !== "text") return;
      var seen = {}, order = [], filled = 0;
      for (var j = 0; j < rows.length; j += 1) {
        var value = rows[j].text(field.name).trim();
        if (!value) continue;
        filled += 1;
        if (!seen[value]) { seen[value] = 0; order.push(value); }
        seen[value] += 1;
      }
      if (order.length < 2 || order.length > 8 || order.length >= filled) return;
      var rank = [field.kind === "option" ? 0 : 1, order.length];
      if (best && (best.rank[0] < rank[0] || (best.rank[0] === rank[0] && best.rank[1] <= rank[1]))) return;
      // 表里出现的先后就是列的先后：待办通常写在已完成前面，字母序会把它打乱。
      best = { field: field, values: order, rank: rank };
    });
    return best;
  }

  function ticket(row) {
    var card = make("article", undefined, "ticket");
    card.append(make("strong", row.text(fields[0].name) || "（无名）", "ticket-title"));
    var meta = make("div", undefined, "ticket-meta");
    fields.forEach(function (field, index) {
      if (index === 0 || (grouping && field.id === grouping.field.id)) return;
      if (!row.has(field.name)) return;
      var cell = row.cell(field.name);
      if (!cell) return;
      var piece = make("span");
      // 标签、人名、链接按含义画；其余画成「列名 值」。
      if (cell.kind === "option" || cell.kind === "options" || cell.kind === "people" || cell.kind === "link") {
        Table.paint(piece, cell);
        if (!piece.textContent && !piece.firstElementChild) return;
      } else {
        var shown = row.text(field.name);
        if (!shown) return;
        piece.append(document.createTextNode(field.name + " "), text(make("b"), shown));
      }
      meta.append(piece);
    });
    if (meta.childNodes.length) card.append(meta);
    return card;
  }

  function draw() {
    var needle = (q.value || "").trim().toLowerCase();
    var rows = Table.rows().filter(function (row) {
      if (!needle) return true;
      return fields.some(function (field) { return row.text(field.name).toLowerCase().indexOf(needle) >= 0; });
    });
    board.replaceChildren();
    var columns = grouping ? grouping.values.slice() : [];
    var held = {};
    columns.forEach(function (name) { held[name] = []; });
    var loose = [];
    rows.forEach(function (row) {
      var key = grouping ? row.text(grouping.field.name).trim() : "";
      if (key && held[key]) held[key].push(row); else loose.push(row);
    });
    // 没填分组的那一撮单开一列，放最后：它是余数，不是一个阶段。
    if (loose.length) { columns.push(OTHER); held[OTHER] = loose; }
    columns.forEach(function (name) {
      var column = make("section", undefined, "column");
      var head = make("header", undefined, "column-head");
      head.append(make("span", name), make("span", String(held[name].length), "column-count"));
      column.append(head);
      var body = make("div", undefined, "column-body");
      held[name].forEach(function (row) { body.append(ticket(row)); });
      column.append(body);
      board.append(column);
    });
    empty.hidden = rows.length > 0;
    board.hidden = rows.length === 0;
    text(count, rows.length === Table.rowCount() ? "共 " + Table.rowCount() + " 条" : rows.length + " / " + Table.rowCount() + " 条");
  }

  function redraw() {
    fields = Table.fields();
    if (!fields.length) return;
    grouping = chooseGrouping();
    var source = Table.schema().source || {};
    text(document.getElementById("eyebrow"), grouping ? "按「" + grouping.field.name + "」分列" : "项目进度");
    text(document.getElementById("title"), source.title || (fields[0].name + "进度"));
    var when = Table.readAt();
    text(document.getElementById("stamp"), when ? "上次更新 " + when.toLocaleString("zh-CN", { hour12: false }) : "");
    text(document.getElementById("foot"), Table.truncated()
      ? "只显示了表格的前 " + Table.rowCount() + " 条；要看更多，在「文档网站」里把行数上限调大。"
      : "数据来自飞书表格，改表格这里就会跟着变。");
    draw();
  }

  q.addEventListener("input", draw);
  Table.onChange(redraw);
  redraw();
})();
