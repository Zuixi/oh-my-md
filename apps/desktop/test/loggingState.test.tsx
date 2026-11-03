import { renderHook } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { useLoggingState } from "../src/useLoggingState"
import type { DesktopServices } from "../src/desktopServices"

it("waits for application initialization before querying native logging state", async () => {
  const getLogState = vi.fn(async () => ({ degraded: false, dir: "/logs", destination: { kind: "directory" as const } }))
  const services: Pick<DesktopServices, "getLogState"> = { getLogState }
  const { result, rerender } = renderHook(({ ready }) => useLoggingState(services, ready), { initialProps: { ready: false } })
  expect(getLogState).not.toHaveBeenCalled()
  rerender({ ready: true })
  await vi.waitFor(() => expect(result.current?.dir).toBe("/logs"))
  expect(getLogState).toHaveBeenCalledTimes(1)
})
