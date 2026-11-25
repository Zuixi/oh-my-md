import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { Check, Code, Copy, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react"
import {
  renderMermaidSvg,
  resolveDocumentMermaidTheme,
  subscribeDocumentMermaidTheme,
  type MediaInspectTarget,
  type MermaidTheme,
} from "@omd/engine"
import { useT } from "./i18n"
import {
  IDENTITY_TRANSFORM,
  LIGHTBOX_CLICK_DRAG_THRESHOLD_PX,
  LIGHTBOX_DOUBLE_CLICK_SCALE,
  LIGHTBOX_KEY_PAN_PX,
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_ZOOM_STEP,
  applyWheelGesture,
  clampPan,
  fitScale,
  normalizeLightboxSvgElement,
  panBy,
  serializeSvgForClipboard,
  zoomAtPoint,
  type BoxSize,
  type LightboxTransform,
} from "./lightboxTransform"

const MERMAID_MAX_AUTO_SCALE = 1.5
const COPY_FEEDBACK_MS = 1500

interface DragState {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  moved: boolean
}

interface ZoomUiState {
  readonly percent: number
  readonly atMin: boolean
  readonly atMax: boolean
}

type MediaLoadState = "loading" | "ready" | "error"

function zoomUiOf(scale: number): ZoomUiState {
  return {
    percent: Math.round(scale * 100),
    atMin: scale <= LIGHTBOX_MIN_SCALE,
    atMax: scale >= LIGHTBOX_MAX_SCALE,
  }
}

function formatTransform(t: LightboxTransform): string {
  return `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`
}

function measureSvgUnscaled(content: HTMLElement | null, svg: Element): BoxSize | null {
  const prevTransform = content?.style.transform ?? ""
  if (content) content.style.transform = "none"
  const rect = svg.getBoundingClientRect()
  if (content) content.style.transform = prevTransform
  return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null
}

/**
 * Bind lightbox state to the active tab/document identity so switching tabs,
 * closing a tab, or reloading a document automatically dismisses any stale
 * inspection overlay and its `editSource` closure.
 */
export function useMediaLightbox(activeTabId: number, activeDocumentId: number) {
  const [target, setTarget] = useState<MediaInspectTarget | null>(null)
  useEffect(() => { setTarget(null) }, [activeTabId, activeDocumentId])
  const close = useCallback(() => setTarget(null), [])
  return { target, open: setTarget, close }
}

export function MediaLightbox(props: {
  target: MediaInspectTarget | null
  onClose: () => void
}) {
  if (!props.target) return null
  return <MediaLightboxDialog target={props.target} onClose={props.onClose} />
}

function MediaLightboxDialog(props: {
  target: MediaInspectTarget
  onClose: () => void
}) {
  const { target, onClose } = props
  const t = useT()
  const rawId = useId()
  const svgPrefix = useMemo(() => `omd-lb-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [rawId])
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const stageRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const svgFrameRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const contentSizeRef = useRef<BoxSize | null>(null)
  const transformRef = useRef<LightboxTransform>(IDENTITY_TRANSFORM)
  const userAdjustedRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const mermaidSeqRef = useRef(0)

  const [zoomUi, setZoomUi] = useState<ZoomUiState>(() => zoomUiOf(1))
  const [dragging, setDragging] = useState(false)
  const [copiedSvg, setCopiedSvg] = useState(false)
  const [imgState, setImgState] = useState<MediaLoadState>("loading")
  const [mermaidState, setMermaidState] = useState<MediaLoadState>("loading")
  const [mermaidTheme, setMermaidTheme] = useState<MermaidTheme>(resolveDocumentMermaidTheme)

  const viewportSize = useCallback((): BoxSize | null => {
    const stage = stageRef.current
    if (!stage) return null
    const rect = stage.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null
  }, [])

  const flushTransformToDom = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    const content = contentRef.current
    if (content) content.style.transform = formatTransform(transformRef.current)
  }, [])

  /**
   * Commit a new transform with pan clamping. High-frequency gestures (drag, wheel)
   * coalesce DOM writes into a single rAF per frame with zero React re-renders;
   * React state updates only when the toolbar zoom percentage or min/max flags change.
   */
  const commitTransform = useCallback((next: LightboxTransform, immediate = false) => {
    const clamped = clampPan(next, contentSizeRef.current, viewportSize())
    transformRef.current = clamped

    if (immediate || typeof requestAnimationFrame !== "function") {
      flushTransformToDom()
    } else if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const content = contentRef.current
        if (content) content.style.transform = formatTransform(transformRef.current)
      })
    }

    const nextUi = zoomUiOf(clamped.scale)
    setZoomUi(prev => (
      prev.percent === nextUi.percent && prev.atMin === nextUi.atMin && prev.atMax === nextUi.atMax
        ? prev
        : nextUi
    ))
  }, [flushTransformToDom, viewportSize])

  const computeFitTransform = useCallback((): LightboxTransform => {
    const vp = viewportSize()
    const size = contentSizeRef.current
    if (!vp || !size) return IDENTITY_TRANSFORM
    const maxAuto = target.kind === "mermaid" ? MERMAID_MAX_AUTO_SCALE : 1
    return { scale: fitScale(size.width, size.height, vp.width, vp.height, maxAuto), x: 0, y: 0 }
  }, [target.kind, viewportSize])

  // Open the native modal <dialog> exactly once per mount and keep Escape/close
  // synced with React state. `onClose` is read through a ref: a parent re-render
  // with a fresh callback identity must not close and reopen the modal (which
  // would drop the SVG DOM, the transform, and focus).
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal()
      else dialog.setAttribute("open", "")
    }
    closeBtnRef.current?.focus()
    const restoreOpenerFocus = () => {
      const opener = openerRef.current
      openerRef.current = null
      if (opener?.isConnected) opener.focus()
    }
    const handleClose = () => {
      onCloseRef.current()
      restoreOpenerFocus()
    }
    dialog.addEventListener("close", handleClose)
    return () => {
      dialog.removeEventListener("close", handleClose)
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close()
        else dialog.removeAttribute("open")
      }
      restoreOpenerFocus()
    }
  }, [])

  // Track `data-theme` changes so an open Mermaid lightbox re-renders in the new theme.
  useEffect(() => {
    if (target.kind !== "mermaid") return
    setMermaidTheme(resolveDocumentMermaidTheme())
    return subscribeDocumentMermaidTheme(setMermaidTheme)
  }, [target.kind])

  // Render Mermaid directly from source through the shared engine pipeline (fresh id,
  // Mermaid's strict DOMPurify sanitization, HTML5 DOM mount — no XML round-trip), or
  // initialize intrinsic dimensions for already-cached images.
  useEffect(() => {
    setCopiedSvg(false)
    userAdjustedRef.current = false
    if (target.kind === "mermaid") {
      let cancelled = false
      const frame = svgFrameRef.current
      if (frame) frame.replaceChildren()
      contentSizeRef.current = null
      setMermaidState("loading")
      commitTransform(IDENTITY_TRANSFORM, true)

      const renderId = `${svgPrefix}-${++mermaidSeqRef.current}`
      void renderMermaidSvg(target.source, {
        id: renderId,
        theme: mermaidTheme,
        useCache: false,
      }).then(rendered => {
        if (cancelled) return
        const currentFrame = svgFrameRef.current
        if (!currentFrame) return
        currentFrame.innerHTML = rendered.svg
        rendered.bindFunctions?.(currentFrame)
        const svg = currentFrame.querySelector("svg")
        if (!svg) {
          currentFrame.replaceChildren()
          contentSizeRef.current = null
          setMermaidState("error")
          return
        }
        const intrinsic = normalizeLightboxSvgElement(svg)
        setMermaidState("ready")
        const measured = intrinsic ?? measureSvgUnscaled(contentRef.current, svg)
        contentSizeRef.current = measured
        commitTransform(measured ? computeFitTransform() : IDENTITY_TRANSFORM, true)
      }, () => {
        if (cancelled) return
        svgFrameRef.current?.replaceChildren()
        contentSizeRef.current = null
        setMermaidState("error")
        commitTransform(IDENTITY_TRANSFORM, true)
      })
      return () => { cancelled = true }
    }

    const img = imgRef.current
    if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      contentSizeRef.current = { width: img.naturalWidth, height: img.naturalHeight }
      setImgState("ready")
      commitTransform(computeFitTransform(), true)
      return
    }
    contentSizeRef.current = null
    setImgState("loading")
    commitTransform(IDENTITY_TRANSFORM, true)
  }, [target, mermaidTheme, svgPrefix, computeFitTransform, commitTransform])

  // Keep fit/clamping accurate when the desktop window is resized while inspecting.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (!userAdjustedRef.current) commitTransform(computeFitTransform(), true)
      else commitTransform(transformRef.current, true)
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [computeFitTransform, commitTransform])

  // Non-passive wheel listener: pinch zooms, two-finger trackpad pans, mouse wheel zooms at cursor.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      userAdjustedRef.current = true
      const rect = stage.getBoundingClientRect()
      const focalX = Number.isFinite(event.clientX) ? event.clientX - (rect.left + rect.width / 2) : 0
      const focalY = Number.isFinite(event.clientY) ? event.clientY - (rect.top + rect.height / 2) : 0
      const next = applyWheelGesture(
        transformRef.current,
        {
          deltaX: Number.isFinite(event.deltaX) ? event.deltaX : 0,
          deltaY: Number.isFinite(event.deltaY) ? event.deltaY : 0,
          ctrlKey: Boolean(event.ctrlKey),
          metaKey: Boolean(event.metaKey),
          deltaMode: Number.isFinite(event.deltaMode) ? event.deltaMode : 0,
        },
        focalX,
        focalY,
      )
      commitTransform(next)
    }
    stage.addEventListener("wheel", handleWheel, { passive: false })
    return () => stage.removeEventListener("wheel", handleWheel)
  }, [commitTransform])

  const zoomIn = useCallback(() => {
    userAdjustedRef.current = true
    const cur = transformRef.current
    commitTransform(zoomAtPoint(cur, cur.scale * LIGHTBOX_ZOOM_STEP, 0, 0), true)
  }, [commitTransform])

  const zoomOut = useCallback(() => {
    userAdjustedRef.current = true
    const cur = transformRef.current
    commitTransform(zoomAtPoint(cur, cur.scale / LIGHTBOX_ZOOM_STEP, 0, 0), true)
  }, [commitTransform])

  const resetFit = useCallback(() => {
    userAdjustedRef.current = false
    commitTransform(computeFitTransform(), true)
  }, [commitTransform, computeFitTransform])

  const resetActual = useCallback(() => {
    userAdjustedRef.current = true
    commitTransform(IDENTITY_TRANSFORM, true)
  }, [commitTransform])

  const closeDialog = useCallback(() => {
    const dialog = dialogRef.current
    if (dialog?.open && typeof dialog.close === "function") {
      dialog.close()
      return
    }
    onClose()
  }, [onClose])

  const handleEditSource = useCallback(() => {
    const edit = target.editSource
    closeDialog()
    edit?.()
  }, [target, closeDialog])

  const handleCopySvg = useCallback(() => {
    if (target.kind !== "mermaid" || mermaidState !== "ready") return
    const svg = svgFrameRef.current?.querySelector("svg")
    const write = navigator.clipboard?.writeText
    if (!svg || !write) return
    const payload = serializeSvgForClipboard(svg)
    void write.call(navigator.clipboard, payload).then(() => {
      setCopiedSvg(true)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null
        setCopiedSvg(false)
      }, COPY_FEEDBACK_MS)
    }, () => {})
  }, [target, mermaidState])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    // Isolate modal keyboard input so App-level window shortcuts never fire behind the lightbox.
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      closeDialog()
      return
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      zoomIn()
      return
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault()
      zoomOut()
      return
    }
    if (event.key === "0") {
      event.preventDefault()
      resetFit()
      return
    }
    if (event.key === "1") {
      event.preventDefault()
      resetActual()
      return
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      userAdjustedRef.current = true
      commitTransform(panBy(transformRef.current, LIGHTBOX_KEY_PAN_PX, 0), true)
      return
    }
    if (event.key === "ArrowRight") {
      event.preventDefault()
      userAdjustedRef.current = true
      commitTransform(panBy(transformRef.current, -LIGHTBOX_KEY_PAN_PX, 0), true)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      userAdjustedRef.current = true
      commitTransform(panBy(transformRef.current, 0, LIGHTBOX_KEY_PAN_PX), true)
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      userAdjustedRef.current = true
      commitTransform(panBy(transformRef.current, 0, -LIGHTBOX_KEY_PAN_PX), true)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.lastX
    const dy = event.clientY - drag.lastY
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    if (!drag.moved) {
      const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
      if (dist > LIGHTBOX_CLICK_DRAG_THRESHOLD_PX) drag.moved = true
    }
    if (drag.moved) {
      userAdjustedRef.current = true
      commitTransform(panBy(transformRef.current, dx, dy))
    }
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>, allowBackdropClose: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.moved) flushTransformToDom()
    if (allowBackdropClose && !drag.moved && event.target === stageRef.current) {
      closeDialog()
    }
  }

  const handleMediaDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const focalX = event.clientX - (rect.left + rect.width / 2)
    const focalY = event.clientY - (rect.top + rect.height / 2)
    const fit = computeFitTransform()
    const cur = transformRef.current
    if (Math.abs(cur.scale - fit.scale) > 0.05 || cur.x !== 0 || cur.y !== 0) {
      userAdjustedRef.current = false
      commitTransform(fit, true)
      return
    }
    userAdjustedRef.current = true
    commitTransform(
      zoomAtPoint(cur, Math.max(fit.scale * LIGHTBOX_DOUBLE_CLICK_SCALE, LIGHTBOX_DOUBLE_CLICK_SCALE), focalX, focalY),
      true,
    )
  }

  const caption = target.kind === "image"
    ? (target.title || target.alt || target.src)
    : t("lightbox.mermaidTitle")

  return (
    <dialog
      ref={dialogRef}
      className="media-lightbox"
      aria-label={t("lightbox.aria.dialog")}
      onKeyDown={handleKeyDown}
    >
      <div className="media-lightbox-toolbar">
        <span className="media-lightbox-caption" title={caption}>{caption}</span>
        <div className="media-lightbox-controls">
          <button
            type="button"
            className="media-lightbox-btn"
            onClick={zoomOut}
            disabled={zoomUi.atMin}
            aria-label={t("lightbox.zoomOut")}
            title={t("lightbox.zoomOut")}
          >
            <ZoomOut size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="media-lightbox-btn media-lightbox-zoom-readout"
            onClick={resetFit}
            aria-label={`${zoomUi.percent}% · ${t("lightbox.fit")}`}
            title={t("lightbox.fit")}
          >
            {zoomUi.percent}%
          </button>
          <button
            type="button"
            className="media-lightbox-btn"
            onClick={zoomIn}
            disabled={zoomUi.atMax}
            aria-label={t("lightbox.zoomIn")}
            title={t("lightbox.zoomIn")}
          >
            <ZoomIn size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="media-lightbox-btn"
            onClick={resetFit}
            aria-label={t("lightbox.fit")}
            title={t("lightbox.fit")}
          >
            <Maximize2 size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="media-lightbox-btn"
            onClick={resetActual}
            aria-label={t("lightbox.actualSize")}
            title={t("lightbox.actualSize")}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          {target.kind === "mermaid" ? (
            <button
              type="button"
              className="media-lightbox-btn"
              onClick={handleCopySvg}
              disabled={mermaidState !== "ready"}
              aria-label={copiedSvg ? t("lightbox.copiedSvg") : t("lightbox.copySvg")}
              title={copiedSvg ? t("lightbox.copiedSvg") : t("lightbox.copySvg")}
            >
              {copiedSvg ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            </button>
          ) : null}
          {target.editSource ? (
            <button
              type="button"
              className="media-lightbox-btn"
              onClick={handleEditSource}
              aria-label={t("lightbox.editSource")}
              title={t("lightbox.editSource")}
            >
              <Code size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            ref={closeBtnRef}
            className="media-lightbox-btn media-lightbox-close"
            onClick={closeDialog}
            aria-label={t("lightbox.close")}
            title={t("lightbox.close")}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`media-lightbox-stage${dragging ? " is-dragging" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={event => finishDrag(event, true)}
        onPointerCancel={event => finishDrag(event, false)}
      >
        <div
          ref={contentRef}
          className="media-lightbox-content"
          style={{ transform: formatTransform(transformRef.current) }}
          onDoubleClick={handleMediaDoubleClick}
        >
          {target.kind === "image" ? (
            imgState === "error" ? (
              <div className="media-lightbox-broken" role="status">
                {t("image.broken", { src: target.src })}
              </div>
            ) : (
              <img
                ref={imgRef}
                className={`media-lightbox-img${imgState === "loading" ? " is-loading" : ""}`}
                src={target.resolvedSrc}
                alt={target.alt}
                decoding="async"
                draggable={false}
                onLoad={event => {
                  const img = event.currentTarget
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    contentSizeRef.current = { width: img.naturalWidth, height: img.naturalHeight }
                    commitTransform(computeFitTransform(), true)
                  }
                  setImgState("ready")
                }}
                onError={() => setImgState("error")}
              />
            )
          ) : (
            <>
              <div
                ref={svgFrameRef}
                className="media-lightbox-svg-frame"
                hidden={mermaidState !== "ready"}
              />
              {mermaidState === "error" ? (
                <div className="media-lightbox-broken" role="status">
                  {t("lightbox.mermaidTitle")}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="media-lightbox-hint" aria-hidden="true">
        {t("lightbox.hint")}
      </div>
    </dialog>
  )
}
