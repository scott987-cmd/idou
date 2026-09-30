# Bundled Feishu CLI

Feishu CLI ships inside the application as a native child-process executable. It remains independently versioned; bundling does not require modifying Codex or Feishu source code.

```text
application/
  src/
  bin/
  upstreams.lock.json
  release/manifest.json
  release/manifest.sig.json
  third_party/codex/{LICENSE,NOTICE}
  resources/lark-cli/darwin-arm64/
    lark-cli
    LICENSE
```

In the [macOS application](#macos-application) the same directory sits at `process.resourcesPath/lark-cli`, outside any archive, and is sealed by the application's signature.

## Build and release

1. On the build machine, obtain the pinned official `larksuite/cli` source checkout. Review and pin its commit, Go toolchain, build tag and resulting binary digest in `upstreams.lock.json`. The current darwin-arm64 artifact is built from version 1.0.78 commit `03de81c5f3986c2af98a3296328df9c98afabd39`, Go 1.24.3 and the upstream `authsidecar` tag; this is reproducibly hash-checked but not a publisher-signed binary.
2. Run `npm run bundle:feishu -- /absolute/path/to/larksuite-cli-checkout`. The script rejects a dirty/wrong checkout, compiles the reviewed credential-isolating variant, verifies its digest, version, skill discovery and skill reading, then copies the binary and license. It never copies upstream installers, credentials, profiles, or caches.
3. Run `npm run check` and `npm run doctor`, then build and verify the sandbox candidate. Only after those contract tests pass, sign the reviewed build record with `IDOU_RELEASE_SIGNING_KEY_FILE=/absolute/server-only/key.pem npm run release:sign -- --release-id <immutable-id> --sandbox-record <absolute-record.json>`. The Ed25519 private key is never stored in the repository or application; its public key is pinned in product code. A release ID is immutable and historical manifests remain under `release/history/`.
4. Use `npm pack --pack-destination dist` for the current portable Node application archive. Its prepack gate fails if the host bundle is absent or altered. This is a local archive build, not publication to npm.
5. Package each target in a clean build directory. Only macOS arm64 is currently pinned and exercised; other targets fail explicitly until their binaries, digests, licenses and native smoke tests are added.

`upstreams.lock.json` is still the reviewed input, but it is no longer sufficient authority at runtime. `release/manifest.json` binds its exact SHA-256 and contents to the application version/source digest, package-lock digest, Codex and Feishu adapter protocols, official Codex license/notice hashes, and the approved immutable sandbox image digest. Desktop/provider resolution, Agent shell startup and the sandbox scheduler all reject a changed or unsigned combination. A verified release is cached only for that process lifetime; an upgrade requires restart. Historical signed manifests are the rollback units; do not edit them in place.

Runtime locates resources relative to the installed application, independent of the user's working directory. Direct provider calls use an absolute path; the Agent also gets the bundled directory prepended to PATH and an instruction specifying the exact executable. Missing or corrupt bundles fail with a repair/build diagnostic instead of downloading software or running an unrelated global CLI.

## macOS application

`npm run package:mac` builds `dist/i豆.app` on an Apple silicon Mac from what is already installed. It downloads nothing, and it replaces only a build of its own.

```text
i豆.app/Contents/
  MacOS/idou                 Electron's executable, renamed: under Electron's name app.isPackaged is false
  Info.plist                 io.github.scott987-cmd.idou (IDOU_BUNDLE_ID), i豆, an Apple Events usage description
  Frameworks/                Electron's framework and helpers, as shipped
  Resources/
    app/                     package/package-lock, signed release, notices, upstream lock, src/, bin/ and runtime node_modules
    lark-cli/darwin-arm64/   the reviewed binary and LICENSE, checksum checked before the build
    codex/                   the pinned Codex in its npm layout: bin/codex, codex-path/rg, codex-resources/
    node/                    the pinned official Node: bin/node and its LICENSE
    idou-build.json          what went in, sealed by the signature
```

The bundle id is `io.github.scott987-cmd.idou`, or `IDOU_BUNDLE_ID` when set. A Mac that already ran the app under its former name (a 我的豆包 profile in Application Support) gets `com.mydoubao.desktop` instead, so the privacy grants and the Keychain item recorded for that id stay valid.

1. Install the locked dependencies (`npm ci`), the reviewed `lark-cli` (above) and `@openai/codex` at the version pinned in `upstreams.lock.json`. Any other Codex version is refused. Place the pinned Node: download the official archive named in `src/providers/node-pin.json` from nodejs.org, check `SHASUMS256.txt` against the Node.js release keys and the archive against it, unpack it, and run `node scripts/bundle-node.js darwin-arm64 /absolute/path/to/node-v<version>-darwin-arm64`; it takes `bin/node` and `LICENSE` only if each matches the pinned digest.
2. Run `npm run package:mac`. It signs with the first Apple Development identity in the login keychain, or with `IDOU_SIGN_IDENTITY` (a SHA-1 hash or a name; `-` signs ad hoc). macOS may ask whether codesign may use the key; that answer is the person's. The build verifies the signature strictly and prints its designated requirement.
   To build for one organisation, set `IDOU_PACKAGE_SERVER_URL` to its control plane (e.g. `IDOU_PACKAGE_SERVER_URL=https://idou.example.com npm run package:mac`). The address goes into `Contents/Resources/app/deployment.json`, sealed by the signature and recorded in `idou-build.json`, and only one the desktop accepts as a control plane is taken. A machine that has never signed in then opens straight to that deployment's sign-in; without it, a Finder launch has no server until `IDOU_SERVER_URL` is set once. The desktop takes, in order: `IDOU_SERVER_URL`, an `.idou.json` in the working directory, the packaged address, then the server the last account signed in to, so a new build can move everyone to a new address.
3. Run `npm run test:packaged-app`. Against a scripted model, and with the bare PATH Finder gives an app, it verifies the signed release and Codex notices from inside the package, checks that this is the packaged app reading its own resources, that it read the login shell's PATH, that a coding turn ran on the bundled Codex, that the Agent's shell reaches the bundled rg, and that with no other node the Agent runs the document tool on the application's own runtime.

The identity is the point. macOS attributes Accessibility and Screen Recording to the responsible process: a development build started from a terminal borrows the terminal's grants, one started from Finder has only its own, and granting `com.github.Electron` grants every Electron development app on the machine. Signed with a development certificate, the designated requirement names the bundle id and that certificate rather than a hash of the build, so a rebuild signed with the same certificate still satisfies what macOS recorded with a grant. An ad hoc signature's requirement is a hash, and each rebuild is a new app to macOS.

### Electron's switches, and the Node the app carries

Before signing, the build turns off three of Electron's fuses: **RunAsNode**, **NODE_OPTIONS** and **--inspect**. With any of them, whoever can start the application can hand the signed binary a script, and the script runs with the application's identity: its Keychain item, the privacy permissions macOS granted it. `npm run package:mac` reads the fuses back from the signed bundle, and `npm run test:packaged-app` refuses a build that has one on; since driving an app needs --inspect, the smoke runs a copy of the build with that one switch turned back on and signed ad hoc.

What the application itself runs as Node -- the model gateway's token helper that Codex runs for every request, the built-in connectors, the Agent's tool, and the Agent's `node` on a machine without one -- no longer runs on Electron. A packaged app carries the official Node build pinned in `src/providers/node-pin.json` (not in `upstreams.lock.json`: that lock's digest is bound into every sandbox image, and this Node is no part of the sandbox; under `src/`, the pin is covered by the signed release all the same), and every file of it is checked against the pin before each Codex launch (`src/providers/node-runtime.js`). In development nothing changes: the desktop's Electron is told to act as Node, or plain Node runs the scripts.

What is still open: `--remote-debugging-port` reaches the renderer, and without the hardened runtime a library can be injected at launch. Both close with the hardened runtime and notarization, which need a Developer ID certificate.

At run time a packaged app reads the person's PATH from their login shell once, runs only the Codex inside the bundle, and gives the Agent's shell a `node` fallback that runs the application's own runtime. Before each launch every file of that Codex -- the binary, its helper, its ripgrep and its shell -- is checked against the digests in `upstreams.lock.json`, and a tree with a changed, missing or added file is refused; the files are hashed again only when their metadata (inode, size, mtime, ctime) has moved. `npm run package:mac` checks the local Codex install the same way before it executes anything from it, and checks both CLIs again once they are inside the bundle. No browser is bundled: the browser connector uses Playwright's Chromium where one is installed, and the system Chrome otherwise.

This is a build for the Mac it was made on. Without the hardened runtime and notarization, Gatekeeper on another Mac refuses it; distribution needs a Developer ID certificate, the hardened runtime with Electron's entitlements, and notarization. Only darwin-arm64 is built.

## Upgrades and private edition

Update the independently pinned CLI version/digests, run the provider suite on the candidate binaries, then ship a new signed application/runtime release. Do not run `lark-cli update` inside an installed application. Installation resources should be read-only for the Agent; prompt instructions alone do not enforce this boundary.

An absolute `IDOU_FEISHU_BIN` override, and `IDOU_CODEX_BIN`, are for developer testing and are reported as `development-override` / `development` by doctor. A packaged app refuses both: a replacement would be an unreviewed program holding the person's credentials, chosen by an environment variable. Neither can be set from `.idou.json`. Replacements enter through a new lock entry and a new signed build.

The Codex digests are first-use pins: npm checks a platform tarball against the registry's sha512 while installing, but keeps no record of it, and `@openai/codex` publishes no per-file digests, so the lock records the bytes that ran the verified tasks. The npm platform package omits license files; the official Apache-2.0 `LICENSE` and `NOTICE` from the matching `rust-v0.147.0` source tag now live under `third_party/codex/`, are hashed by the signed release, and are copied into both the macOS app and sandbox image.

Bundling alone does not authorize an account. Credentials are never bundled. In configured SaaS deployments the [single-login bridge](feishu-cli-bridge.md) supplies only a loopback/HMAC environment to this build and retains Feishu credentials on the server; without that explicit capability, the independent developer CLI workflow remains.
