// 数据看板 · 页面逻辑
//
// 数据从 Table 拿（data/table.js）。表格里的内容是别人写的，所以一律用
// textContent 放进页面，永远不要拼 innerHTML。
(function () {
  "use strict";
  var BLANK = "未填写";
  var fields = Table.fields();
  var numeric = fields.filter(function (field) { return field.kind === "number"; });
  var q = document.getElementById("q");
  // 排序和分类筛选的当前状态。都是页面自己的事，不回头去读表。
  var sort = { field: null, direction: 1 };
  var picked = "";
  var facet = null;
  var rowsBody = document.getElementById("rows");
  var empty = document.getElementById("empty");
  var count = document.getElementById("count");

  function text(node, value) { node.textContent = value == null ? "" : String(value); return node; }
  function make(tag, value, className) {
    var node = document.createElement(tag);
    if (value !== undefined) text(node, value);
    if (className) node.className = className;
    return node;
  }
  function number(value) {
    return typeof value === "number" && isFinite(value)
      ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
      : "—";
  }

  // 概览：记录数，加上每个数字列的合计。想改成平均值或别的，改这里。
  function drawTiles() {
    var tiles = document.getElementById("tiles");
    tiles.replaceChildren();
    var rows = Table.rows();
    var first = make("div", undefined, "tile");
    first.append(text(make("b"), rows.length.toLocaleString("zh-CN")), make("span", "条记录"));
    tiles.append(first);
    numeric.slice(0, 3).forEach(function (field) {
      var total = 0, seen = 0;
      rows.forEach(function (row) {
        var value = row.value(field.name);
        if (typeof value === "number" && isFinite(value)) { total += value; seen += 1; }
      });
      var tile = make("div", undefined, "tile");
      tile.append(text(make("b"), seen ? number(total) : "—"), make("span", field.name + " · 合计"));
      tiles.append(tile);
    });
  }

  // 点表头排序：数字和日期按值比，其余按文本比。再点一次反向，第三次取消。
  function drawHead() {
    var head = document.getElementById("head-row");
    head.replaceChildren();
    fields.forEach(function (field) {
      var th = make("th");
      var button = make("button", field.name, "sort");
      button.type = "button";
      if (sort.field === field.id) {
        button.append(make("span", sort.direction > 0 ? "↑" : "↓", "arrow"));
        th.setAttribute("aria-sort", sort.direction > 0 ? "ascending" : "descending");
      }
      button.onclick = function () {
        if (sort.field !== field.id) sort = { field: field.id, direction: 1 };
        else if (sort.direction > 0) sort.direction = -1;
        else sort = { field: null, direction: 1 };
        drawHead(); draw();
      };
      th.append(button);
      if (field.kind === "number") th.className = "num";
      head.append(th);
    });
  }

  // 哪一列适合当分类。关键那一条是：**有值的每一行都各不相同的列是名字，不是分类**，
  // 按它筛一次只剩一行，那不叫筛选。第一版拿取值数和「所有行」比，于是真实表里
  // 只要有空行，客户名称那一列就混过了这一关，标签栏变成一个客户一个标签。
  function chooseFacet() {
    var rows = Table.rows(), best = null;
    fields.forEach(function (field) {
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
      // 表格自己说是「单选」的列，比看起来像分类的文本列更可信；同级之间取值越少越好筛。
      var rank = [field.kind === "option" ? 0 : 1, distinct];
      if (best && (best.rank[0] < rank[0] || (best.rank[0] === rank[0] && best.rank[1] <= rank[1]))) return;
      best = { field: field, values: Object.keys(seen).sort(), rank: rank };
    });
    return best;
  }

  function drawFacet() {
    var bar = document.getElementById("facet");
    bar.replaceChildren();
    bar.hidden = !facet;
    if (!facet) return;
    [{ label: "全部", value: "" }].concat(facet.values.map(function (value) { return { label: value, value: value }; }))
      .forEach(function (choice) {
        var chip = make("button", choice.label, "facet-chip");
        chip.type = "button";
        chip.setAttribute("aria-pressed", picked === choice.value ? "true" : "false");
        chip.onclick = function () { picked = choice.value; drawFacet(); draw(); };
        bar.append(chip);
      });
  }

  // 一张按分类汇总的条形图。没有图表库，就是几个 div，CSP 下也能用。
  function drawChart(rows) {
    var chart = document.getElementById("chart");
    chart.replaceChildren();
    var measure = numeric[0];
    if (!facet || !measure) { chart.hidden = true; return; }
    var totals = {};
    rows.forEach(function (row) {
      var key = row.text(facet.field.name).trim() || BLANK;
      var value = row.value(measure.name);
      totals[key] = (totals[key] || 0) + (typeof value === "number" && isFinite(value) ? value : 0);
    });
    // 从大到小，但没有分类的那一撮永远排最后：它是余数，放在图的顶上会被当成一个分类。
    var keys = Object.keys(totals).sort(function (a, b) {
      if (a === BLANK) return 1;
      if (b === BLANK) return -1;
      return totals[b] - totals[a];
    }).slice(0, 8);
    var top = keys.reduce(function (most, key) { return Math.max(most, totals[key]); }, 0);
    if (!keys.length || top <= 0) { chart.hidden = true; return; }
    chart.hidden = false;
    chart.append(make("h2", facet.field.name + " · " + measure.name, "chart-title"));
    keys.forEach(function (key) {
      var row = make("div", undefined, "bar-row");
      var fill = make("span", undefined, "bar-fill");
      // 合计是 0 就一点都不画。给 0 留一截「看得见的最小宽度」是在说假话。
      fill.style.width = totals[key] > 0 ? Math.max(2, Math.round((totals[key] / top) * 100)) + "%" : "0";
      var track = make("span", undefined, "bar-track");
      track.append(fill);
      row.append(make("span", key, "bar-label"), track, make("span", number(totals[key]), "bar-value"));
      chart.append(row);
    });
  }

  function compare(a, b) {
    if (!sort.field) return 0;
    var field = fields.filter(function (item) { return item.id === sort.field; })[0];
    if (!field) return 0;
    var left = a.value(field.name), right = b.value(field.name);
    var numeric = typeof left === "number" && typeof right === "number";
    if (!numeric) { left = a.text(field.name); right = b.text(field.name); }
    if (left === right) return 0;
    if (left === null || left === "") return 1;
    if (right === null || right === "") return -1;
    return (numeric ? (left < right ? -1 : 1) : String(left).localeCompare(String(right), "zh-CN")) * sort.direction;
  }

  function draw() {
    var needle = (q.value || "").trim().toLowerCase();
    var rows = Table.rows().filter(function (row) {
      if (facet && picked && row.text(facet.field.name).trim() !== picked) return false;
      if (!needle) return true;
      return fields.some(function (field) { return row.text(field.name).toLowerCase().indexOf(needle) >= 0; });
    }).sort(compare);
    drawChart(rows);
    rowsBody.replaceChildren();
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      fields.forEach(function (td) {
        var cell = make("td");
        if (!row.has(td.name)) { text(cell, "无权查看"); cell.className = "blank"; }
        else {
          // 按字段的含义画：单选是标签，人员是名字，链接是链接，日期是日期，钱是钱。
          Table.paint(cell, row.cell(td.name));
          if (td.kind === "number") cell.className = "num";
          if (!cell.textContent && !cell.firstElementChild) { text(cell, "—"); cell.className = "blank"; }
        }
        tr.append(cell);
      });
      rowsBody.append(tr);
    });
    empty.hidden = rows.length > 0;
    text(count, rows.length === Table.rowCount() ? Table.rowCount() + " 条" : rows.length + " / " + Table.rowCount() + " 条");
  }

  function drawStamp() {
    var when = Table.readAt();
    text(document.getElementById("stamp"), when ? "上次更新 " + when.toLocaleString("zh-CN", { hour12: false }) : "");
    text(document.getElementById("foot"), Table.truncated()
      ? "只显示了表格的前 " + Table.rowCount() + " 条；要看更多，在「文档网站」里把行数上限调大。"
      : "数据来自飞书表格，改表格这里就会跟着变。");
  }

  function redraw() {
    fields = Table.fields();
    numeric = fields.filter(function (field) { return field.kind === "number"; });
    var named = (Table.schema().source || {}).title;
    text(document.getElementById("title"), named || "数据看板");
    text(document.getElementById("eyebrow"), named ? "数据看板" : "飞书表格");
    facet = chooseFacet();
    if (facet && facet.values.indexOf(picked) < 0) picked = "";
    drawTiles(); drawFacet(); drawHead(); draw(); drawStamp();
  }

  q.addEventListener("input", draw);
  Table.onChange(redraw);
  redraw();
})();
