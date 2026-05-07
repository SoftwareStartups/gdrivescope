# GitHub Configuration

## SHA Pinning Policy

All actions pinned to **full 40-character commit SHAs**. Tags are mutable and can be hijacked — SHAs are immutable.

Format: `uses: owner/action@<full-sha>  # v1.2.3`

Resolve latest version and SHA:

```bash
for repo in actions/checkout actions/upload-artifact actions/download-artifact actions/cache; do
  tag=$(gh api "repos/$repo/releases/latest" --jq '.tag_name')
  ref=$(gh api "repos/$repo/git/ref/tags/$tag" --jq '.object')
  type=$(echo "$ref" | jq -r '.type')
  sha=$(echo "$ref" | jq -r '.sha')
  if [ "$type" = "tag" ]; then
    sha=$(gh api "repos/$repo/git/tags/$sha" --jq '.object.sha')
  fi
  echo "$repo@$tag → $sha"
done
```

## Shell Injection Prevention

Never interpolate GitHub context variables directly in `run:` scripts — always route them through `env:` first. Attacker-controlled values like branch names, PR titles, issue bodies, or commit messages can contain shell metacharacters that break out of the string and execute arbitrary code in the runner.

Bad:

```yaml
- run: echo "${{ github.event.pull_request.title }}"
```

Good:

```yaml
- env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "$PR_TITLE"
```

Applies to **every** `${{ }}` expression used inside a `run:` block — `github.ref_name`, `github.head_ref`, `github.sha`, `github.repository`, `github.actor`, `inputs.*`, and anything derived from them. The `env:` indirection forces the value through shell variable expansion, which is safe.

## CI Workflow (`workflows/ci.yml`)

- Triggers: push to any branch, PRs to `main`
- Permissions: `contents: read` only
- Single job: `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` → `cargo test` → `cargo build --release` → musl `cargo check` smoke test
- Toolchain pinned via `rust-toolchain.toml`; the runner's pre-installed `rustup` picks it up automatically — no third-party setup action

## Release Workflow (`workflows/release.yml`)

- Triggers: push of `v*` tags
- Permissions: `contents: write`, `actions: read`
- 6-platform binary matrix:
  - linux-x64 → `x86_64-unknown-linux-musl` (fully static)
  - linux-arm64 → `aarch64-unknown-linux-gnu`
  - darwin-x64 → `x86_64-apple-darwin`
  - darwin-arm64 → `aarch64-apple-darwin`
  - windows-x64 → `x86_64-pc-windows-msvc`
  - windows-arm64 → `aarch64-pc-windows-msvc`
- Binary naming: `gdrivescope-<os>-<arch>[.exe]` archived as `.tar.gz` (Linux/macOS) or `.zip` (Windows)
- macOS: linker emits `Signature=adhoc` automatically; the workflow asserts it via `codesign -dvv` so the binary doesn't SIGKILL on Sequoia+
- A final `release` job collects all artifacts, generates `SHA256SUMS.txt`, and publishes a GitHub release with auto-generated notes

## Custom Actions

None. The Rust toolchain is provided by the runner's pre-installed `rustup`,
which respects `rust-toolchain.toml` automatically.
