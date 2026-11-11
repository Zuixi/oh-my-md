import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ExportProgressToast } from "../src/exportProgressToast"
import { t } from "../src/i18n"

describe("export progress toast", () => {
  it("renders a visible Cancel button and calls both cancel and close", () => {
    const onCancel = vi.fn()
    const closeToast = vi.fn()
    render(
      <ExportProgressToast
        message={t("export.progress")}
        onCancel={onCancel}
        closeToast={closeToast}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: t("export.cancel") }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(closeToast).toHaveBeenCalledOnce()
  })
})
