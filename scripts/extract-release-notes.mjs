#!/usr/bin/env node
// Extracts the CHANGELOG.md section for one release tag so the release workflow
// publishes curated notes instead of a wall of commit subjects.
import { appendFileSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"

const DEFAULT_CHANGELOG = "CHANGELOG.md"
const OUTPUT_KEY = "changelog"
// The release workflow reads this exact delimiter back from $GITHUB_OUTPUT.
const OUTPUT_DELIMITER = "__OMD_CHANGELOG_EOF__"
// Version-agnostic: a missing section must never leak a stale tag into the body.
const FALLBACK_NOTES = "See the commit log for changes in this release."

function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      changelog: { type: "string", default: DEFAULT_CHANGELOG },
      "github-output": { type: "string" },
    },
  })
  const version = parseVersion(values.tag)
  const notes = extractSection(readFileSync(values.changelog, "utf8"), version)
  const body = notes === "" ? FALLBACK_NOTES : notes
  const bodyLines = body.split("\n")
  const outputPath = values["github-output"]
  if (outputPath === undefined) {
    process.stdout.write(`${body}\n`)
    return
  }
  // A body line equal to the delimiter would silently truncate the value GitHub
  // reads back, so refuse instead of corrupting the release page.
  if (bodyLines.includes(OUTPUT_DELIMITER)) {
    throw new Error(`${OUTPUT_KEY} contains the ${OUTPUT_DELIMITER} output delimiter; refusing ${outputPath}`)
  }
  appendFileSync(outputPath, `${OUTPUT_KEY}<<${OUTPUT_DELIMITER}\n${body}\n${OUTPUT_DELIMITER}\n`)
  process.stdout.write(`${OUTPUT_KEY}: ${bodyLines.length} line(s) for ${version}\n`)
}

// `github.ref_name` is a tag such as v0.1.5, but a bare 0.1.5 must work too.
function parseVersion(tag) {
  const version = (tag ?? "").trim().replace(/^v/, "")
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`--tag must be a semver release tag such as v0.1.5 (got ${JSON.stringify(tag ?? "")})`)
  }
  return version
}

// Returns the trimmed body between `## v<version> ...` and the next `## ` heading.
function extractSection(markdown, version) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const heading = new RegExp(`^## v?${version.replaceAll(".", "\\.")}(?:\\s+-.*)?\\s*$`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return ""
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  return lines.slice(start + 1, next === -1 ? lines.length : next).join("\n").trim()
}

try {
  main()
} catch (error) {
  console.error(`[release-notes] ${error.message}`)
  process.exitCode = 1
}
