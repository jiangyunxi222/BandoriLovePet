"use strict";

function wrapRotation(angle) {
  const wrapped = angle % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped < -180 ? wrapped + 360 : wrapped || 0;
}

function bindRotationGestures(host, { target, readAngle, rotate, reset, start, finish, readHeight, pinch }) {
  const fingers = new Map();
  let chord, pinchGesture, lastTap, downAt, moved, suppressClick;
  function span() {
    const [first, second] = fingers.values();
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  function center(points) {
    return points.reduce((sum, point) => ({
      x: sum.x + point.x / 3, y: sum.y + point.y / 3,
    }), { x: 0, y: 0 });
  }

  host.addEventListener("pointerdown", (event) => {
    if (!fingers.size) {
      suppressClick = false;
      downAt = event.timeStamp;
      moved = false;
    }
    if (event.pointerType !== "touch" || (!fingers.size && !target(event))) return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY, downX: event.clientX, downY: event.clientY });
    if (chord) chord.canceled = true;
    else if (fingers.size === 2 && pinch) {
      const height = readHeight();
      if (height) {
        pinchGesture = { height, span: Math.max(1, span()) };
        suppressClick = true;
        start?.();
      }
    }
    else if (fingers.size === 3) {
      const layer = target(event);
      if (!layer) return;
      const points = [...fingers.values()];
      chord = { layer, points, origin: center(points), angle: readAngle(layer),
        joined: event.timeStamp - downAt <= 200, rotating: false };
      suppressClick = true;
      if (!pinchGesture) start?.();
    }
    if (chord || pinchGesture) {
      for (const id of fingers.keys()) host.setPointerCapture(id);
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  function paint() {
    chord.frame = 0;
    if (chord.canceled || chord.released) return;
    const points = [...fingers.values()];
    const next = center(points);
    let dot = 0, cross = 0;
    for (const [index, point] of points.entries()) {
      const x = chord.points[index].x - chord.origin.x, y = chord.points[index].y - chord.origin.y;
      const dx = point.x - next.x, dy = point.y - next.y;
      dot += x * dx + y * dy;
      cross += x * dy - y * dx;
    }
    if (Math.hypot(dot, cross) < 16) return;
    const delta = Math.atan2(cross, dot) * 180 / Math.PI;
    if (!chord.rotating && Math.abs(delta) < 4) return;
    chord.rotating = true;
    rotate(chord.layer, wrapRotation(chord.angle + delta));
  }

  host.addEventListener("pointermove", (event) => {
    const point = fingers.get(event.pointerId);
    if (!point) return;
    fingers.set(event.pointerId, { ...point, x: event.clientX, y: event.clientY });
    moved ||= Math.hypot(event.clientX - point.downX, event.clientY - point.downY) > 12;
    if (chord) {
      if (!chord.frame && !chord.canceled && !chord.released) chord.frame = requestAnimationFrame(paint);
    } else if (pinchGesture) {
      if (fingers.size === 2 && !pinchGesture.released) pinch(pinchGesture.height * span() / pinchGesture.span);
    } else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function end(event) {
    const point = fingers.get(event.pointerId);
    if (!point) return;
    if (chord) {
      chord.canceled ||= event.type !== "pointerup";
      moved ||= Math.hypot(event.clientX - point.downX, event.clientY - point.downY) > 12;
      if (chord.frame) { cancelAnimationFrame(chord.frame); paint(); }
      chord.released = true;
      event.stopImmediatePropagation();
    } else if (pinchGesture) {
      pinchGesture.released = true;
      event.stopImmediatePropagation();
    }
    fingers.delete(event.pointerId);
    if (fingers.size) return;
    if (chord?.joined && !chord.canceled && !chord.rotating && !moved && event.timeStamp - downAt <= 290) {
      if (lastTap?.layer === chord.layer && downAt - lastTap.time <= 360 &&
          Math.hypot(chord.origin.x - lastTap.origin.x, chord.origin.y - lastTap.origin.y) <= 44) {
        reset(chord.layer);
        lastTap = null;
      } else lastTap = { time: event.timeStamp, layer: chord.layer, origin: chord.origin };
    } else lastTap = null;
    if (chord || pinchGesture) finish?.(Boolean(chord?.rotating));
    chord = null;
    pinchGesture = null;
  }
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  host.addEventListener("lostpointercapture", (event) => {
    if (event.target === host) end(event);
  });

  host.addEventListener("click", (event) => {
    if (suppressClick || event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  host.addEventListener("wheel", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const layer = target(event);
    const delta = event.deltaY || event.deltaX;
    if (!layer || !delta) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    rotate(layer, wrapRotation(readAngle(layer) - Math.sign(delta) * 5));
    finish?.(true);
  }, { capture: true, passive: false });
  host.addEventListener("dblclick", (event) => {
    const layer = event.altKey && target(event);
    if (!layer) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    reset(layer);
  }, true);
}
