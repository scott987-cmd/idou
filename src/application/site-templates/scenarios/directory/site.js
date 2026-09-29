// 名单查询 · 页面逻辑
//
// 第一列当标题，其余列列在卡片里。表格里的内容是别人写的，一律用 textContent，
// 永远不要拼 innerHTML。
(function () {
  "use strict";
  // 分类筛选最多认这么多个取值；超过就说明这一列不适合当分类。
  var MAX_CHOICES = 12;
  var fields = Table.fields();
  var picked = "";
  var facet = null;

  var q = document.getElementById("q");
  var cards = document.getElementById("cards");
  var chips = document.getElementById("chips");
  var empty = document.getElementById("empty");

  function text(node, value) { node.textContent = value == null ? "" : String(value); return node; }
  function make(tag, value, className) {
    var node = document.createElement(tag);
    if (value !== undefined) text(node, value);
    if (className) node.className = className;
    return node;
  }

  // 只有取值能成堆的列才值得拿来筛。有值的每一行都各不相同的列是名字，不是分类：
  // 按它做出来的标签，一个只选中一张卡片。拿取值数和「所有行」比而不是和「有值的行」
  // 比，真实表里只要有空行就会漏过去。
  function chooseFacet(rows) {
    var best = null;
    for (var i = 1; i < fields.length; i += 1) {
      if (fields[i].kind !== "text" && fields[i].kind !== "option") continue;
      var values = {}, distinct = 0, filled = 0;
      for (var j = 0; j < rows.length; j += 1) {
        var value = rows[j].text(fields[i].name).trim();
        if (!value) continue;
        filled += 1;
        if (!values[value]) { values[value] = 0; distinct += 1; }
        values[value] += 1;
      }
      if (distinct < 2 || distinct > MAX_CHOICES || distinct >= filled) continue;
      // 单选字段优先；同级之间取值越少越好筛。
      var rank = [fields[i].kind === "option" ? 0 : 1, distinct];
      if (best && (best.rank[0] < rank[0] || (best.rank[0] === rank[0] && best.rank[1] <= rank[1]))) continue;
      best = { field: fields[i], values: Object.keys(values).sort(), rank: rank };
    }
    return best;
  }

  function drawChips() {
    chips.replaceChildren();
    chips.hidden = !facet;
    if (!facet) return;
    var all = [{ label: "全部", value: "" }].concat(facet.values.map(function (value) { return { label: value, value: value }; }));
    all.forEach(function (choice) {
      var chip = make("button", choice.label, "facet-chip");
      chip.type = "button";
      chip.setAttribute("aria-pressed", picked === choice.value ? "true" : "false");
      chip.onclick = function () { picked = choice.value; drawChips(); draw(); };
      chips.append(chip);
    });
  }

  function draw() {
    var needle = (q.value || "").trim().toLowerCase();
    var rows = Table.rows().filter(function (row) {
      if (facet && picked && row.text(facet.field.name).trim() !== picked) return false;
      if (!needle) return true;
      return fields.some(function (field) { return row.text(field.name).toLowerCase().indexOf(needle) >= 0; });
    });
    cards.replaceChildren();
    rows.forEach(function (row) {
      var card = make("article", undefined, "card");
      card.append(make("h2", row.text(fields[0].name) || "（无名）"));
      var list = document.createElement("dl");
      fields.slice(1).forEach(function (field) {
        list.append(make("dt", field.name));
        var value = make("dd");
        if (!row.has(field.name)) { text(value, "无权查看"); value.className = "blank"; }
        else {
          Table.paint(value, row.cell(field.name));
          if (field.kind === "number") value.className = "num";
          if (!value.textContent && !value.firstElementChild) { text(value, "—"); value.className = "blank"; }
        }
        list.append(value);
      });
      if (fields.length > 1) card.append(list);
      cards.append(card);
    });
    empty.hidden = rows.length > 0;
    text(document.getElementById("count"),
      rows.length === Table.rowCount() ? "共 " + Table.rowCount() + " 条" : rows.length + " / " + Table.rowCount() + " 条");
  }

  function redraw() {
    fields = Table.fields();
    if (!fields.length) return;
    var rows = Table.rows();
    facet = chooseFacet(rows);
    if (facet && facet.values.indexOf(picked) < 0) picked = "";
    text(document.getElementById("eyebrow"), "名单查询");
    text(document.getElementById("title"), (Table.schema().source || {}).title || (fields[0].name + "名单"));
    var when = Table.readAt();
    text(document.getElementById("stamp"), when ? "上次更新 " + when.toLocaleString("zh-CN", { hour12: false }) : "");
    text(document.getElementById("foot"), Table.truncated()
      ? "只显示了表格的前 " + Table.rowCount() + " 条；要看更多，在「文档网站」里把行数上限调大。"
      : "数据来自飞书表格，改表格这里就会跟着变。");
    drawChips();
    draw();
  }

  q.addEventListener("input", draw);
  Table.onChange(redraw);
  redraw();
})();
