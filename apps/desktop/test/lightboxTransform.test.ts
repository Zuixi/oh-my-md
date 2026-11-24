// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import {
  IDENTITY_TRANSFORM,
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_MIN_VISIBLE_PX,
  applyWheelGesture,
  clampPan,
  clampScale,
  fitScale,
  panBy,
  prepareLightboxSvg,
  wheelZoomScale,
  zoomAtPoint,
} from "../src/lightboxTransform"

describe("lightboxTransform", () => {
  it("clamps scale to configured min/max bounds and handles non-finite inputs", () => {
    expect(clampScale(0.01)).toBe(LIGHTBOX_MIN_SCALE)
    expect(clampScale(99)).toBe(LIGHTBOX_MAX_SCALE)
    expect(clampScale(2.5)).toBe(2.5)
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it("keeps the focal point anchored during zoomAtPoint", () => {
    const start = { scale: 1, x: 0, y: 0 }
    const zoomed = zoomAtPoint(start, 2, 100, -50)
    // A point at (100, -50) in stage coordinates maps to content coord (100, -50) at scale 1.
    // After scaling to 2x with translation (-100, 50), 2 * 100 + (-100) = 100, 2 * (-50) + 50 = -50.
    expect(zoomed).toEqual({ scale: 2, x: -100, y: 50 })

    // Zooming again around the same focal point preserves it
    const zoomedAgain = zoomAtPoint(zoomed, 4, 100, -50)
    expect(zoomedAgain.scale).toBe(4)
    expect(100 * 4 + zoomedAgain.x).toBeCloseTo(100)
    expect(-50 * 4 + zoomedAgain.y).toBeCloseTo(-50)
  })

  it("returns the same transform reference when scale is unchanged", () => {
    const atMax = { scale: LIGHTBOX_MAX_SCALE, x: 10, y: 20 }
    expect(zoomAtPoint(atMax, LIGHTBOX_MAX_SCALE + 2, 0, 0)).toBe(atMax)
  })

  it("pans by delta offsets and returns same reference on zero delta", () => {
    expect(panBy(IDENTITY_TRANSFORM, 0, 0)).toBe(IDENTITY_TRANSFORM)
    expect(panBy({ scale: 2, x: 10, y: -5 }, 15, 25)).toEqual({ scale: 2, x: 25, y: 20 })
  })

  it("zooms in on negative wheel deltaY and zooms out on positive deltaY", () => {
    expect(wheelZoomScale(1, -120)).toBeGreaterThan(1)
    expect(wheelZoomScale(1, 120)).toBeLessThan(1)
  })

  it("distinguishes trackpad pinch, trackpad two-finger pan, and mouse wheel zoom", () => {
    const wheel = applyWheelGesture(IDENTITY_TRANSFORM, { deltaX: 0, deltaY: -10, ctrlKey: false, deltaMode: 0 }, 0, 0)
    const pinch = applyWheelGesture(IDENTITY_TRANSFORM, { deltaX: 0, deltaY: -10, ctrlKey: true, deltaMode: 0 }, 0, 0)
    expect(pinch.scale).toBeGreaterThan(wheel.scale)

    const panned = applyWheelGesture(IDENTITY_TRANSFORM, { deltaX: 24, deltaY: -12, ctrlKey: false, deltaMode: 0 }, 0, 0)
    expect(panned).toEqual({ scale: 1, x: -24, y: 12 })
  })

  it("clamps pan so at least LIGHTBOX_MIN_VISIBLE_PX stays reachable in viewport", () => {
    const content = { width: 400, height: 200 }
    const viewport = { width: 1000, height: 800 }
    const maxX = viewport.width / 2 + content.width / 2 - LIGHTBOX_MIN_VISIBLE_PX
    const maxY = viewport.height / 2 + content.height / 2 - LIGHTBOX_MIN_VISIBLE_PX

    expect(clampPan({ scale: 1, x: 9999, y: -9999 }, content, viewport)).toEqual({
      scale: 1,
      x: maxX,
      y: -maxY,
    })
    const inside = { scale: 1, x: 50, y: -30 }
    expect(clampPan(inside, content, viewport)).toBe(inside)
  })

  it("computes fitScale respecting viewport padding and maxAutoScale", () => {
    // Wide 2000x500 diagram in 1096x896 viewport -> available 1000x800 -> scale 0.5
    expect(fitScale(2000, 500, 1096, 896, 1)).toBeCloseTo(0.5)
    // Small 200x100 image does not upscale past 1
    expect(fitScale(200, 100, 1096, 896, 1)).toBe(1)
    // Vector diagram may auto-scale up to 1.5
    expect(fitScale(200, 100, 1096, 896, 1.5)).toBe(1.5)
    // Zero dimensions degrade safely to 1
    expect(fitScale(0, 100, 1096, 896)).toBe(1)
  })

  it("prepares Mermaid SVG by extracting viewBox size, removing max-width, and namespacing ids safely", () => {
    const raw = '<svg id="omd-mmd-1" style="max-width: 600px;" viewBox="0 0 1200 400"><defs><marker id="omd-mmd-1-arrow"/></defs><style>#omd-mmd-1 .node { fill: red; }</style><path marker-end="url(#omd-mmd-1-arrow)"/><text>omd-mmd-10</text></svg>'
    const prepared = prepareLightboxSvg(raw, "omd-lb-test")
    expect(prepared.width).toBe(1200)
    expect(prepared.height).toBe(400)
    expect(prepared.markup).not.toContain("max-width")
    expect(prepared.markup).toContain('id="omd-lb-test-omd-mmd-1"')
    expect(prepared.markup).toContain("#omd-lb-test-omd-mmd-1 .node")
    expect(prepared.markup).toContain("url(#omd-lb-test-omd-mmd-1-arrow)")
    expect(prepared.markup).toContain("<text>omd-mmd-10</text>")
  })

  it("rewrites ids by DOM traversal, never by matching label text", () => {
    // `omd-mmd-1` is both the root id and the exact text of a diagram label. Only
    // the id and its references may change; the label is user content.
    const raw = [
      '<svg id="omd-mmd-1" viewBox="0 0 10 10">',
      '<defs><marker id="omd-mmd-1-arrow"/></defs>',
      '<style>#omd-mmd-1 .node { fill: red; } #omd-mmd-10 .node { fill: blue; } #omd-mmd-1x .node { fill: green; }</style>',
      '<path id="omd-mmd-10" marker-end="url(#omd-mmd-1-arrow)" clip-path="url(#omd-mmd-1)" fill="#omd-mmd-1"/>',
      '<text>omd-mmd-1</text><tspan>omd-mmd-1</tspan>',
      '</svg>',
    ].join("")
    const markup = prepareLightboxSvg(raw, "omd-lb").markup
    expect(markup).toContain('id="omd-lb-omd-mmd-1"')
    expect(markup).toContain('id="omd-lb-omd-mmd-1-arrow"')
    expect(markup).toContain('id="omd-lb-omd-mmd-10"')
    expect(markup).toContain("#omd-lb-omd-mmd-1 .node")
    expect(markup).toContain("#omd-lb-omd-mmd-10 .node")
    expect(markup).toContain("url(#omd-lb-omd-mmd-1-arrow)")
    expect(markup).toContain("clip-path=\"url(#omd-lb-omd-mmd-1)\"")
    expect(markup).toContain('fill="#omd-lb-omd-mmd-1"')
    // Boundary guard: a longer id sharing the prefix (and an id-like token that
    // is not an element id) is left exactly as-is.
    expect(markup).toContain("#omd-mmd-1x .node")
    expect(markup).toContain("<text>omd-mmd-1</text>")
    expect(markup).toContain("<tspan>omd-mmd-1</tspan>")
  })

  it("strips scriptable elements, event handlers, and unsafe URLs", () => {
    const raw = [
      '<svg id="d" viewBox="0 0 10 10">',
      '<script>alert(1)</script>',
      '<iframe src="https://evil.test"/>',
      '<object data="x"/><embed src="x"/>',
      '<rect width="10" height="10" onload="alert(1)" onclick="alert(2)"/>',
      '<a href="javascript:alert(1)"><text>link</text></a>',
      '<image href="data:text/html;base64,PHNjcmlwdD4="/>',
      '<use href="#d"/>',
      '</svg>',
    ].join("")
    const markup = prepareLightboxSvg(raw, "omd-lb").markup
    for (const forbidden of ["<script", "<iframe", "<object", "<embed", "onload", "onclick", "javascript:", "data:text/html"]) {
      expect(markup).not.toContain(forbidden)
    }
    // Safe in-document references survive sanitization.
    expect(markup).toContain('href="#omd-lb-d"')
    expect(markup).toContain('id="omd-lb-d"')
  })

  it("falls back cleanly on malformed SVG markup", () => {
    // Never echo unparsed markup: the lightbox renders its broken state instead.
    for (const malformed of ["<not-svg", "<svg><unclosed"]) {
      expect(prepareLightboxSvg(malformed, "prefix")).toEqual({
        markup: "",
        width: null,
        height: null,
      })
    }
  })
})
