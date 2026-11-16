(function () {
  var canvas = document.createElement("canvas");
  var context = canvas.getContext("2d");
  if (context) context.fillText("fixture", 1, 1);
  new Image().src = "http://static.example.com/lib-pixel.png";
})();