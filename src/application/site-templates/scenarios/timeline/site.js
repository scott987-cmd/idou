// 时间线 · 页面逻辑
//
// 按日期那一列把记录排成一条线，同一个月归在一起。数据从 Table 拿
// （data/table.js）。表格里的内容是别人写的，所以一律用 textContent 放进页面，
// 永远不要拼 innerHTML。
(function () {
  "use strict";
  var UNDATED = "未填日期";
  var fields = Table.fields();
  var q = document.getElementById("q");
  var line = document.getElementById("line");
  var empty = document.getElementById("empty");
  var count = document.getElementById("count");
  var facetBar = document.getElementById("facet");
  var when = null, facet = null, picked = "";

  function text(node, value) { node.textContent = value == null ? "" : String(value); return node; }
  function make(tag, value, className) {
    var node = document.createElement(tag);
    if (value !== undefined) text(node, value);
    if (className) node.className = className;
    return node;
  }

  // 哪一列是时间。优先表格自己说是日期的那一列；一张没有日期列的表画不成时间线，
  // 这时就按表里的顺序排，并且不写月份——编一个日期出来比不写更糟。
  function chooseWhen() {
    for (var i = 0; i < fields.length; i += 1) if (fields[i].kind === "date") return fields[i];
    return null;
  }

  // 分类筛选和别的模版同一条规矩：有值的每一行都各不相同的列是名字，不是分类。
  function chooseFacet() {
    var rows = Table.rows(), best = null;
    fields.forEach(function (field, index) {
      if (index === 0 || (when && field.id === when.id)) return;
      if (field.kind !== "option" && field.kind !== "text") return;
      var seen = {}, distinct = 0, filled = 0;
      for (var j = 0; j < rows.length; j += 1) {
        var value = rows[j].text(field.name).trim();
        if (!value) continue;
        filled += 1;
        if (!seen[value]) { seen[value] = 0; distinct += 1; }
        seen[value] += 1;
      }
      if (distinct < 2 || distinct > 12 || distinct >= filled) return;
      var rank = [field.kind === "option" ? 0 : 1, distinct];
      if (best && (best.rank[0] < rank[0] || (best.rank[0] === rank[0] && best.rank[1] <= rank[1]))) return;
      best = { field: field, values: Object.keys(seen).sort(), rank: rank };
    });
    return best;
  }

  function drawFacet() {
    facetBar.replaceChildren();
    facetBar.hidden = !facet;
    if (!facet) return;
    [{ label: "全部", value: "" }].concat(facet.values.map(function (value) { return { label: value, value: value }; }))
      .forEach(function (choice) {
        var chip = make("button", choice.label, "facet-chip");
        chip.type = "button";
        chip.setAttribute("aria-pressed", picked === choice.value ? "true" : "false");
        chip.onclick = function () { picked = choice.value; drawFacet(); draw(); };
        facetBar.append(chip);
      });
  }

  function period(row) {
    if (!when) return "";
    var at = row.value(when.name);
    if (typeof at !== "number" || !isFinite(at)) return UNDATED;
    var date = new Date(at);
    return date.getFullYear() + " 年 " + (date.getMonth() + 1) + " 月";
  }

  function event(row) {
    var item = make("article", undefined, "event");
    if (when) item.append(make("span", row.text(when.name) || "—", "event-when"));
    item.append(make("strong", row.text(fields[0].name) || "（无名）", "event-title"));
    var body = make("div", undefined, "event-body");
    fields.forEach(function (field, index) {
      if (index === 0 || (when && field.id === when.id)) return;
      if (!row.has(field.name)) return;
      var cell = row.cell(field.name);
      if (!cell) return;
      var piece = make("span");
      if (cell.kind === "option" || cell.kind === "options" || cell.kind === "people" || cell.kind === "link") {
        Table.paint(piece, cell);
        if (!piece.textContent && !piece.firstElementChild) return;
      } else {
        var shown = row.text(field.name);
        if (!shown) return;
        piece.append(document.createTextNode(field.name + " "), text(make("b"), shown));
      }
      body.append(piece);
    });
    if (body.childNodes.length) item.append(body);
    return item;
  }

  function draw() {
    var needle = (q.value || "").trim().toLowerCase();
    var rows = Table.rows().filter(function (row) {
      if (facet && picked && row.text(facet.field.name).trim() !== picked) return false;
      if (!needle) return true;
      return fields.some(function (field) { return row.text(field.name).toLowerCase().indexOf(needle) >= 0; });
    });
    if (when) {
      // 新的在上面。没有日期的排在最后：它们不属于任何一个月。
      rows = rows.slice().sort(function (a, b) {
        var left = a.value(when.name), right = b.value(when.name);
        var hasLeft = typeof left === "number" && isFinite(left), hasRight = typeof right === "number" && isFinite(right);
        if (!hasLeft && !hasRight) return 0;
        if (!hasLeft) return 1;
        if (!hasRight) return -1;
        return right - left;
      });
    }
    line.replaceChildren();
    var current = null, group = null;
    rows.forEach(function (row) {
      var label = period(row);
      if (label && label !== current) {
        current = label;
        group = make("li", undefined, "period");
        group.append(make("p", label, "period-label"));
        line.append(group);
      }
      if (!group) { group = make("li", undefined, "period"); line.append(group); }
      group.append(event(row));
    });
    empty.hidden = rows.length > 0;
    line.hidden = rows.length === 0;
    text(count, rows.length === Table.rowCount() ? "共 " + Table.rowCount() + " 条" : rows.length + " / " + Table.rowCount() + " 条");
  }

  function redraw() {
    fields = Table.fields();
    if (!fields.length) return;
    when = chooseWhen();
    facet = chooseFacet();
    if (facet && facet.values.indexOf(picked) < 0) picked = "";
    var source = Table.schema().source || {};
    text(document.getElementById("eyebrow"), when ? "按「" + when.name + "」排序" : "按表格顺序");
    text(document.getElementById("title"), source.title || (fields[0].name + "时间线"));
    var read = Table.readAt();
    text(document.getElementById("stamp"), read ? "上次更新 " + read.toLocaleString("zh-CN", { hour12: false }) : "");
    text(document.getElementById("foot"), Table.truncated()
      ? "只显示了表格的前 " + Table.rowCount() + " 条；要看更多，在「文档网站」里把行数上限调大。"
      : "数据来自飞书表格，改表格这里就会跟着变。");
    drawFacet();
    draw();
  }

  q.addEventListener("input", draw);
  Table.onChange(redraw);
  redraw();
})();
