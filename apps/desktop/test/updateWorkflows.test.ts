import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// Text-level contract tests for the protected stable promotion and withdrawal
// workflows, mirroring the drift-guard style of releaseWorkflow.test.ts.
const PROMOTE = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "workflows", "promote-update.yml"),
  "utf8",
)
const WITHDRAW = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "workflows", "withdraw-update.yml"),
  "utf8",
)

const WORKFLOWS: ReadonlyArray<readonly [string, string]> = [
  ["promote-update.yml", PROMOTE],
  ["withdraw-update.yml", WITHDRAW],
]

// Step-level `run: |` shell bodies. Contract tests assert what may never be
// interpolated into them (no user-controllable inputs expression), so a
// workflow edit that reintroduces `${{ inputs.* }}` into a shell body fails.
function stepRunBlocks(workflow: string): readonly string[] {
  const lines = workflow.split("\n")
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const match = /^(\s*)run: \|$/.exec(lines[i] ?? "")
    if (match === null) {
      i += 1
      continue
    }
    const indent = (match[1] ?? "").length
    const body: string[] = []
    i += 1
    while (i < lines.length) {
      const line = lines[i] ?? ""
      const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0
      if (line.trim() !== "" && leading <= indent) break
      body.push(line)
      i += 1
    }
    blocks.push(body.join("\n"))
  }
  return blocks
}

function groupOf(workflow: string): string | undefined {
  return /^concurrency:\n  group: (.+)$/m.exec(workflow)?.[1]
}

describe("stable update workflows", () => {
  it("are manual dispatch only with no other triggers", () => {
    for (const [, workflow] of WORKFLOWS) {
      expect(workflow).toContain("workflow_dispatch")
      expect(workflow).not.toMatch(/^on:\n  (push|pull_request|schedule):/m)
    }
    expect(PROMOTE).toMatch(/^on:\n  workflow_dispatch:\n    inputs:\n      version:/m)
    expect(WITHDRAW).toMatch(/^on:\n  workflow_dispatch:/m)
    expect(WITHDRAW).not.toContain("inputs:")
  })

  it("require strict semver promotion input and no manual input for withdrawal", () => {
    expect(PROMOTE).toContain("version:")
    expect(PROMOTE).toContain("required: true")
    expect(PROMOTE).toContain("type: string")
    expect(PROMOTE).toContain("MAJOR.MINOR.PATCH")
    expect(PROMOTE).toContain("${{ inputs.version }}")
  })

  it("use the protected stable-updates environment for approval", () => {
    for (const [, workflow] of WORKFLOWS) {
      expect(workflow).toContain("environment: stable-updates")
    }
  })

  it("serialize promotions and withdrawals with the same concurrency group", () => {
    expect(groupOf(PROMOTE)).toBe("stable-updates")
    expect(groupOf(WITHDRAW)).toBe("stable-updates")
    for (const [, workflow] of WORKFLOWS) {
      expect(workflow).toContain("cancel-in-progress: false")
    }
  })

  it("grant exactly contents: read, pages: write, and id-token: write", () => {
    const permissions = "permissions:\n  contents: read\n  pages: write\n  id-token: write"
    for (const [, workflow] of WORKFLOWS) {
      expect(workflow).toContain(permissions)
    }
  })

  it("never receive signing secrets and never run tauri build", () => {
    for (const [, workflow] of WORKFLOWS) {
      expect(workflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY")
      expect(workflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
      expect(workflow).not.toContain("tauri build")
      expect(workflow).not.toContain("--bundles")
    }
  })

  it("deploy the complete Pages site through pinned Pages actions", () => {
    for (const [, workflow] of WORKFLOWS) {
      expect(workflow).toContain("actions/configure-pages@")
      expect(workflow).toContain("actions/upload-pages-artifact@")
      expect(workflow).toContain("actions/deploy-pages@")
      expect(workflow).toMatch(/actions\/configure-pages@[0-9a-f]{40}/)
      expect(workflow).toMatch(/actions\/upload-pages-artifact@[0-9a-f]{40}/)
      expect(workflow).toMatch(/actions\/deploy-pages@[0-9a-f]{40}/)
      expect(workflow).toContain("path: site")
      expect(workflow).toContain("include-hidden-files: true")
    }
  })

  it("retry-fetch the public latest.json and compare its SHA-256", () => {
    for (const [, workflow] of WORKFLOWS) {
      expect(workflow).toContain("zuixi.github.io/oh-my-md")
      expect(workflow).toContain("updates/stable/latest.json")
      expect(workflow).toContain("sha256sum")
      expect(workflow).toContain("--retry")
      expect(workflow).toContain("sleep")
    }
  })
})

describe("stable update workflows input safety", () => {
  it("passes the version input to steps only through a job-level environment variable", () => {
    expect(PROMOTE).toMatch(/\n\s*VERSION: \${{ inputs\.version }}/)
    expect(PROMOTE).toContain('version="$VERSION"')
    expect(PROMOTE).toContain('gh release view "$tag"')
    expect(PROMOTE).toContain('gh release download "v$VERSION"')
    expect(PROMOTE).toContain('--version "$VERSION"')
    expect(PROMOTE).toContain('--tag "v$VERSION"')
    expect(PROMOTE).toContain('releases/tag/v$VERSION"')
  })

  it("never interpolates the version input into any shell body (injection-shaped input rule)", () => {
    const INJECTION_SHAPED = '0.1.1"; touch /tmp/pwned; echo "'
    const mutatedPromote = PROMOTE.split("${{ inputs.version }}").join(INJECTION_SHAPED)
    for (const [, workflow] of WORKFLOWS) {
      for (const block of stepRunBlocks(workflow)) {
        expect(block).not.toContain("inputs.version")
        expect(block).not.toContain("${{ inputs.version }}")
      }
    }
    // Substituting an injection-shaped value for every inputs expression (e.g.
    // the env assignment) must never reach a shell body, because run blocks
    // contain no `${{ inputs.version }}` reference at all.
    for (const block of stepRunBlocks(mutatedPromote)) {
      expect(block).not.toContain(INJECTION_SHAPED)
      expect(block).not.toContain("touch /tmp/pwned")
    }
  })

  it("fetches every indexed history entry from the status versions inventory", () => {
    for (const [, workflow] of WORKFLOWS) {
      expect(workflow).toContain("current-site/updates/stable/history")
      expect(workflow).toContain("updates/stable/status.json")
      expect(workflow).toContain("s.versions")
      expect(workflow).toContain('"updates/stable/history/$version.json"')
    }
    // The deployed tree is reconstructed from the immutable versions index, not
    // by walking the previous-version chain (which would miss a withdrawn
    // version's history entry).
    expect(PROMOTE).not.toMatch(/previousVersion/)
    expect(WITHDRAW).not.toMatch(/previousVersion/)
  })
})

describe("promote-update workflow", () => {
  it("verifies a public non-Draft, non-prerelease Release at the exact tag before downloading", () => {
    expect(PROMOTE).toContain("gh release view")
    expect(PROMOTE).toContain('--repo "$GITHUB_REPOSITORY"')
    expect(PROMOTE).toContain("--json")
    expect(PROMOTE).toContain("tagName")
    expect(PROMOTE).toContain("draft")
    expect(PROMOTE).toContain("prerelease")
    expect(PROMOTE).toContain("r.draft || r.prerelease")
    expect(PROMOTE).toContain('"$release_tag" = "$tag"')
    expect(PROMOTE).toContain("process.exit(1)")
  })

  it("downloads only the candidate manifest, updater artifacts, and signatures", () => {
    expect(PROMOTE).toContain("gh release download")
    expect(PROMOTE).toContain("--pattern 'latest.json'")
    expect(PROMOTE).toContain("--pattern '*.app.tar.gz'")
    expect(PROMOTE).toContain("--pattern '*-setup.exe'")
    expect(PROMOTE).toContain("--pattern '*.AppImage.tar.gz'")
  })

  it("pins a minisign verifier and checks artifacts against the decoded committed public key", () => {
    expect(PROMOTE).toContain(
      "https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-linux.tar.gz",
    )
    expect(PROMOTE).toContain("-Vm")
    expect(PROMOTE).toContain('"$minisign"')
    expect(PROMOTE).toContain("tauri.conf.json")
    expect(PROMOTE).toContain("pubkey")
    expect(PROMOTE).toContain("untrusted comment:")
    expect(PROMOTE).toMatch(/minisign\.pub/)
  })

  it("runs the tested CLI to validate then promote into the site tree", () => {
    const validate = PROMOTE.indexOf("update-manifest.mjs validate")
    const promote = PROMOTE.indexOf("update-manifest.mjs promote")
    expect(validate).toBeGreaterThan(-1)
    expect(promote).toBeGreaterThan(validate)
    expect(PROMOTE).toContain("--manifest release-assets/latest.json")
    expect(PROMOTE).toContain("--assets release-assets")
    expect(PROMOTE).toContain("--candidate release-assets/latest.json")
    expect(PROMOTE).toContain("--current-site current-site")
    expect(PROMOTE).toContain("--release-url")
    expect(PROMOTE).toContain("--workflow-run")
    expect(PROMOTE).toContain("--output-site site")
    expect(PROMOTE).toContain("actions/runs/$GITHUB_RUN_ID")
  })
})

describe("withdraw-update workflow", () => {
  it("runs the tested withdrawal CLI from the fetched current site", () => {
    expect(WITHDRAW).toContain("update-manifest.mjs withdraw")
    expect(WITHDRAW).toContain("--current-site current-site")
    expect(WITHDRAW).toContain("--output-site site")
  })

  it("never calls release, tag, or asset mutation commands", () => {
    expect(WITHDRAW).not.toContain("gh release")
    expect(WITHDRAW).not.toContain("gh tag")
    expect(WITHDRAW).not.toContain("softprops/action-gh-release")
    expect(WITHDRAW).not.toContain("releases/download")
    expect(WITHDRAW).not.toContain("git tag")
    expect(WITHDRAW).not.toContain("actions/upload-artifact@")
  })
})
