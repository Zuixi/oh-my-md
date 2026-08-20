import { useT } from "./i18n"

export interface LargeDocBannerProps {
  readonly lines: number
  readonly safeMode: boolean
  readonly readonly?: boolean
  readonly onDismiss: () => void
}

/** Spec 05：大文档一次性非模态提示。安全模式版本必须说明改变了什么
 *  （渐进渲染 + 按需字数；readonly 变体另说明只读 Live 与内存权衡）。 */
export function LargeDocBanner({ lines, safeMode, readonly, onDismiss }: LargeDocBannerProps) {
  const t = useT()
  const messageKey = readonly
    ? "largeDoc.readonly"
    : safeMode
      ? "largeDoc.safeMode"
      : "largeDoc.notice"
  return (
    <div className="update-banner">
      <p className="update-banner-message" role="status">
        {t(messageKey, { lines })}
      </p>
      <div className="update-banner-actions">
        <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
          {t("largeDoc.dismiss")}
        </button>
      </div>
    </div>
  )
}
