// Search and category filter over the links written in the page. The page is
// complete without this -- every link is there and works -- it only narrows.
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll("#links .card"));
  var find = document.getElementById("find"), count = document.getElementById("count"), facet = document.getElementById("facet"), none = document.getElementById("none");
  var categories = [];
  cards.forEach(function (card) { var name = card.getAttribute("data-category"); if (name && categories.indexOf(name) < 0) categories.push(name); });
  var chosen = null;
  var paint = function () {
    var words = (find.value || "").trim().toLowerCase(), shown = 0;
    cards.forEach(function (card) {
      var fits = (!chosen || card.getAttribute("data-category") === chosen) && (!words || card.textContent.toLowerCase().indexOf(words) >= 0);
      card.hidden = !fits; if (fits) shown += 1;
    });
    count.textContent = shown + " / " + cards.length + " 个入口";
    none.hidden = shown > 0;
  };
  if (categories.length > 1) {
    ["全部"].concat(categories).forEach(function (name, index) {
      var chip = document.createElement("button");
      chip.type = "button"; chip.className = "facet-chip"; chip.textContent = name;
      chip.setAttribute("aria-pressed", index === 0 ? "true" : "false");
      chip.addEventListener("click", function () {
        chosen = index === 0 ? null : name;
        Array.prototype.forEach.call(facet.children, function (other) { other.setAttribute("aria-pressed", other === chip ? "true" : "false"); });
        paint();
      });
      facet.appendChild(chip);
    });
  } else facet.hidden = true;
  find.addEventListener("input", paint);
  paint();
})();
