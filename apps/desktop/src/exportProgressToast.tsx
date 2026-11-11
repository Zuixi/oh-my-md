import { toast } from "react-toastify"
import { t } from "./i18n"

interface Props {
  message: string
  onCancel: () => void
  closeToast?: () => void
}

export function ExportProgressToast({ message, onCancel, closeToast }: Props) {
  return (
    <div className="export-progress-toast" role="status">
      <span>{message}</span>
      <button
        type="button"
        className="export-progress-cancel"
        onClick={() => {
          onCancel()
          closeToast?.()
        }}
      >
        {t("export.cancel")}
      </button>
    </div>
  )
}

/** Indefinite progress toast whose Cancel button flips the export abort flag. */
export function notifyExportProgress(message: string, onCancel: () => void): () => void {
  const id = toast(<ExportProgressToast message={message} onCancel={onCancel} />, {
    autoClose: false,
    closeOnClick: false,
    closeButton: false,
    draggable: false,
  })
  return () => toast.dismiss(id)
}
