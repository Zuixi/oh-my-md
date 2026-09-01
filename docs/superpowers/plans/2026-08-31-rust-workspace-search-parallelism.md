# Rust Workspace Search Parallelism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep workspace Markdown search parallel through line matching and batch collection while preserving every existing search and IPC behavior.

**Architecture:** File reading and line matching produce callback-local hit batches. An atomic slot counter enforces the global cap, and the shared result mutex is held only while appending an accepted batch. Final sorting and response construction remain centralized and deterministic.

**Tech Stack:** Rust, Tauri 2, `ignore`, `regex`, standard atomics and mutexes, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md`

## Global Constraints

- Preserve `search_markdown(root, query, case_sensitive)` and `SearchResponse`.
- Preserve hidden-file, `.gitignore`, non-UTF-8, 5 MiB file, 500-hit, line truncation, UTF-16 offset, sorting, and `truncated` semantics.
- IO-bound commands remain `async fn` plus `spawn_blocking`.
- Do not add a second search implementation or a new dependency.
- Synchronization failures must return explicit errors rather than panic.
- Timing measurements are advisory and must not become flaky CI gates.

---

### Task 1: Extract per-file hit collection

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs:520-601`
- Add tests in: `apps/desktop/src-tauri/src/workspace.rs:758-870`

**Interfaces:**

```rust
fn collect_file_hits(
    path: &Path,
    content: &str,
    matcher: &regex::Regex,
    max_hits: usize,
) -> Vec<SearchHit>
```

- [ ] **Step 1: Write failing pure helper tests**

```rust
#[test]
fn collect_file_hits_stops_at_the_local_limit() {
    let matcher = build_matcher("needle", false).unwrap();
    let hits = collect_file_hits(
        Path::new("/notes/a.md"),
        "needle\nneedle\nneedle\n",
        &matcher,
        2,
    );
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].line, 1);
    assert_eq!(hits[1].line, 2);
}

#[test]
fn collect_file_hits_preserves_utf16_offsets_and_truncated_text() {
    let matcher = build_matcher("needle", false).unwrap();
    let content = format!("🦀 {} needle", "a".repeat(500));
    let hits = collect_file_hits(Path::new("/notes/a.md"), &content, &matcher, 10);
    let hit = &hits[0];
    let selected: Vec<u16> = hit.text.encode_utf16()
        .skip(hit.start)
        .take(hit.end - hit.start)
        .collect();
    assert_eq!(selected, "needle".encode_utf16().collect::<Vec<_>>());
}
```

- [ ] **Step 2: Run focused Rust tests and verify failure**

Run:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  collect_file_hits -- --nocapture
```

Expected: FAIL because `collect_file_hits` does not exist.

- [ ] **Step 3: Move line matching into the helper**

```rust
fn collect_file_hits(
    path: &Path,
    content: &str,
    matcher: &regex::Regex,
    max_hits: usize,
) -> Vec<SearchHit> {
    let mut hits = Vec::with_capacity(max_hits.min(16));
    let display_path = path.to_string_lossy().into_owned();
    for (index, line) in content.lines().enumerate() {
        if hits.len() >= max_hits {
            break;
        }
        if let Some(found) = matcher.find(line) {
            let (text, start, end) = truncate_line(line, found.start(), found.end());
            hits.push(SearchHit {
                path: display_path.clone(),
                line: index + 1,
                text,
                start,
                end,
            });
        }
    }
    hits
}
```

- [ ] **Step 4: Run helper and existing search tests**

Run:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml search_
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src-tauri/src/workspace.rs
git commit -m "refactor: isolate markdown file matching"
```

### Task 2: Add exact atomic slot reservation

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs`
- Add tests in the same module.

**Interfaces:**

```rust
fn reserve_slots(remaining: &AtomicUsize, requested: usize) -> usize
```

- [ ] **Step 1: Write failing reservation tests**

```rust
#[test]
fn reserve_slots_never_exceeds_the_global_limit() {
    let remaining = AtomicUsize::new(3);
    assert_eq!(reserve_slots(&remaining, 2), 2);
    assert_eq!(reserve_slots(&remaining, 2), 1);
    assert_eq!(reserve_slots(&remaining, 1), 0);
    assert_eq!(remaining.load(Ordering::Relaxed), 0);
}

#[test]
fn concurrent_slot_reservations_sum_to_the_limit() {
    let remaining = Arc::new(AtomicUsize::new(500));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let remaining = Arc::clone(&remaining);
            std::thread::spawn(move || reserve_slots(&remaining, 100))
        })
        .collect();
    let reserved: usize = threads.into_iter().map(|thread| thread.join().unwrap()).sum();
    assert_eq!(reserved, 500);
    assert_eq!(remaining.load(Ordering::Relaxed), 0);
}
```

- [ ] **Step 2: Run the reservation tests and verify failure**

Run:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml reserve_slots
```

Expected: FAIL because `reserve_slots` does not exist.

- [ ] **Step 3: Implement lock-free exact reservation**

```rust
fn reserve_slots(remaining: &AtomicUsize, requested: usize) -> usize {
    if requested == 0 {
        return 0;
    }
    match remaining.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
        (current > 0).then_some(current.saturating_sub(requested))
    }) {
        Ok(previous) => previous.min(requested),
        Err(_) => 0,
    }
}
```

- [ ] **Step 4: Run the reservation tests**

Run:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml reserve_slots
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src-tauri/src/workspace.rs
git commit -m "perf: reserve workspace search slots atomically"
```

### Task 3: Batch search results outside the line-scan lock

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs:543-600`
- Add tests in: `apps/desktop/src-tauri/src/workspace.rs:758-870`

**Interfaces:**
- Consumes: `collect_file_hits`, `reserve_slots`.
- Preserves: `search_markdown_sync(...) -> Result<SearchResponse, String>`.

- [ ] **Step 1: Add failing high-contention behavior tests**

```rust
#[test]
fn parallel_search_never_exceeds_the_cap_with_many_hits_per_file() {
    let root = tmp("search-parallel-cap");
    reset_dir(&root);
    let content = std::iter::repeat("needle")
        .take(40)
        .collect::<Vec<_>>()
        .join("\n");
    for index in 0..64 {
        fs::write(root.join(format!("f{index:02}.md")), &content).unwrap();
    }

    let response = search_markdown_sync(&path_string(&root), "needle", false).unwrap();
    assert_eq!(response.hits.len(), MAX_SEARCH_HITS);
    assert!(response.truncated);
    assert!(response.hits.windows(2).all(|pair| {
        pair[0].path < pair[1].path
            || (pair[0].path == pair[1].path && pair[0].line <= pair[1].line)
    }));
    fs::remove_dir_all(root).ok();
}
```

Retain all existing case, hidden-file, long-line, UTF-16, JSON, and cap tests.

- [ ] **Step 2: Run the search tests before implementation**

Run:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml search_
```

Expected: existing tests pass; the new test establishes required semantics but
does not yet prove the lock scope. Inspect the implementation in review: the
task is incomplete while line scanning remains inside the mutex guard.

- [ ] **Step 3: Replace the shared-length loop with local batches**

Use:

```rust
let results = Mutex::new(Vec::new());
let remaining = AtomicUsize::new(MAX_SEARCH_HITS);
let truncated = AtomicBool::new(false);
let synchronization_failed = AtomicBool::new(false);
```

In each walker callback:

```rust
let available = remaining.load(Ordering::Acquire);
if available == 0 {
    truncated.store(true, Ordering::Release);
    return ignore::WalkState::Quit;
}

let mut local = collect_file_hits(path, content, &matcher, available);
let accepted = reserve_slots(&remaining, local.len());
if accepted < local.len() {
    local.truncate(accepted);
    truncated.store(true, Ordering::Release);
}
if local.is_empty() {
    return if remaining.load(Ordering::Acquire) == 0 {
        ignore::WalkState::Quit
    } else {
        ignore::WalkState::Continue
    };
}

match results.lock() {
    Ok(mut shared) => shared.extend(local),
    Err(_) => {
        synchronization_failed.store(true, Ordering::Release);
        return ignore::WalkState::Quit;
    }
}
```

After `walker.run`, return:

```rust
if synchronization_failed.load(Ordering::Acquire) {
    return Err("workspace search result lock poisoned".into());
}
```

Use `Mutex::into_inner().map_err(...)` rather than `unwrap()`.

- [ ] **Step 4: Run search tests repeatedly**

Run:

```sh
for i in 1 2 3 4 5; do
  cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml search_ --quiet || exit 1
done
```

Expected: all five runs PASS with deterministic sorted output and exact cap.

- [ ] **Step 5: Run Rust formatting and module tests**

Run:

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml workspace
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src-tauri/src/workspace.rs
git commit -m "perf: batch parallel workspace search hits"
```

### Task 4: Add advisory search measurement and evaluate quick-open batching

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs`
- Modify only if justified: `apps/desktop/src-tauri/src/workspace.rs:611-653`

**Interfaces:**
- Produces ignored test:

```rust
#[test]
#[ignore = "advisory workspace search benchmark"]
fn workspace_search_parallelism_benchmark()
```

- [ ] **Step 1: Add an ignored deterministic fixture benchmark**

Generate 1,000 Markdown files with 200 lines each, one match per file. Time only
`search_markdown_sync`, print elapsed milliseconds, assert result semantics,
and remove the temporary directory.

```rust
let started = std::time::Instant::now();
let response = search_markdown_sync(&path_string(&root), "needle", false).unwrap();
let elapsed = started.elapsed();
eprintln!("workspace search 1000x200: {:.2}ms", elapsed.as_secs_f64() * 1000.0);
assert_eq!(response.hits.len(), MAX_SEARCH_HITS);
assert!(response.truncated);
```

- [ ] **Step 2: Run and record the advisory number**

Run:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  workspace_search_parallelism_benchmark -- --ignored --nocapture
```

Expected: PASS and print one timing value. Record it in the final integration
appendix, not as a CI assertion.

- [ ] **Step 3: Evaluate quick-open lock scope**

Run the equivalent 5,000-file fixture against `list_markdown_files_sync`.
Because quick-open currently holds the mutex only for one push, change it only
if profiling shows mutex contention is material.

If changed, use a worker-local drop guard that flushes path batches under one
short lock and preserve the exact 5,000-path cap. Add a cap/sort test before
production edits.

If unchanged, record “measured; no production change justified” in the
integration appendix.

- [ ] **Step 4: Run all Rust tests**

Run:

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src-tauri/src/workspace.rs
git commit -m "perf: measure workspace search throughput"
```
