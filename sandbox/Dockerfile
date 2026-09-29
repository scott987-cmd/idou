# The image a scheduled task runs in. One container per run, created when the
# schedule fires and destroyed with it.
#
# What goes in is deliberately small: a Node runtime, the pinned Codex, the
# pinned Feishu CLI, and this product's own sandbox entry point. What stays out
# matters more -- no credential, no key, no session file. The container is given
# a run token at start and reaches exactly one address with it.
#
# Nothing is downloaded while this builds, and the build script runs it with no
# network to make sure of that. Every input is either in the build context,
# already verified against upstreams.lock.json by scripts/build-sandbox-image.js,
# or the base image, named by digest. Build context is the repository root,
# because both CLIs are copied from `resources/`, which is deliberately not in
# version control (hundreds of megabytes of reviewed binaries).
#
# No argument has a default. A default would be a second copy of the lock that
# nothing keeps in step with it; a build that did not come through the script has
# nothing to be checked against, and fails here instead.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG CODEX_VERSION
ARG CODEX_SHA256
# Every file of the Codex tree as `<sha256>  <path>` entries joined by `;`. One
# line, because a build argument is one line.
ARG CODEX_FILES
ARG LARK_CLI_VERSION
ARG LARK_CLI_SHA256
ARG RELEASE_UPSTREAMS_SHA256
ARG SANDBOX_PLATFORM
RUN test -n "${CODEX_VERSION}" && test -n "${CODEX_SHA256}" && test -n "${CODEX_FILES}" \
 && test -n "${LARK_CLI_VERSION}" && test -n "${LARK_CLI_SHA256}" && test -n "${RELEASE_UPSTREAMS_SHA256}" && test -n "${SANDBOX_PLATFORM}" \
 || { echo "Build this image with scripts/build-sandbox-image.js; it passes what upstreams.lock.json pins." >&2; exit 1; }

# Codex exactly as its npm package lays it out -- bin/codex beside
# codex-package.json, codex-path/ and codex-resources/ -- because the binary
# finds its own ripgrep and shell through that layout. It is run directly, the
# way the packaged desktop app runs it; the npm launcher adds only update hints.
# It is copied rather than installed: `npm install` would fetch whatever the
# registry serves under that version, which no review has seen.
#
# The whole tree is checked, and nothing may be added to it: its ripgrep, its
# shell and its bubblewrap run as part of every task, and a library dropped
# beside the binary is loaded by it.
COPY resources/codex/${SANDBOX_PLATFORM}/ /opt/codex/
RUN echo "${CODEX_FILES}" | tr ';' '\n' > /tmp/codex.sha256 \
 && grep -qx "${CODEX_SHA256}  bin/codex" /tmp/codex.sha256 \
 && (cd /opt/codex && sha256sum --strict -c /tmp/codex.sha256) \
 && test "$(find /opt/codex -type f | wc -l)" -eq "$(wc -l < /tmp/codex.sha256)" \
 && test -z "$(find /opt/codex ! -type f ! -type d)" \
 && rm /tmp/codex.sha256 \
 && /opt/codex/bin/codex --version | grep -qx "codex-cli ${CODEX_VERSION}"
ENV PATH=/opt/codex/bin:${PATH}

# The version check stays, but it is not what decides: a binary that prints the
# right version and does something else is exactly what it cannot see. The
# digest is checked first.
COPY resources/lark-cli/${SANDBOX_PLATFORM}/lark-cli /usr/local/bin/lark-cli
COPY resources/lark-cli/${SANDBOX_PLATFORM}/LICENSE /usr/local/share/lark-cli/LICENSE
RUN echo "${LARK_CLI_SHA256}  /usr/local/bin/lark-cli" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/lark-cli \
 && test -s /usr/local/share/lark-cli/LICENSE \
 && lark-cli --version | grep -qx "lark-cli version ${LARK_CLI_VERSION}"

# Codex's npm platform package omits these upstream notices. They are pinned by
# the signed release manifest and shipped beside every redistributed binary.
COPY third_party/codex/LICENSE /usr/local/share/codex/LICENSE
COPY third_party/codex/NOTICE /usr/local/share/codex/NOTICE
RUN test -s /usr/local/share/codex/LICENSE && test -s /usr/local/share/codex/NOTICE

# This product's own code inside the sandbox: the entry point, and the CLI
# sidecar it reuses unchanged. Only what those two import -- the control plane's
# own sources have no business in here, so this is a named list rather than a
# copy of src/.
#
# The sidecar is the same file the desktop runs. Inside the container its
# loopback address is genuinely loopback, and the session it is handed is the
# run token rather than the person's own, so what it can reach dies with the run.
COPY bin/sandbox/ /opt/mydoubao/bin/sandbox/
COPY src/providers/feishu/cli-sidecar.js \
     src/providers/feishu/cli-write-contract.js \
     src/providers/feishu/cli-write-sequence.js \
     src/providers/feishu/cli-write-plan.js \
     src/providers/feishu/openapi.js \
     src/providers/feishu/saas-deployment.js \
     /opt/mydoubao/src/providers/feishu/
COPY src/control-plane/client-session.js /opt/mydoubao/src/control-plane/
COPY src/product-names.js /opt/mydoubao/src/
# The model catalog the Codex configuration names. Without it Codex starts with
# no idea what the configured slug can do.
COPY src/providers/codex/model-catalog.json /opt/mydoubao/src/providers/codex/
RUN chmod 0755 /opt/mydoubao/bin/sandbox/agent-token.js

# What this image says it was built from. The control plane compares these with
# the lock before running anything, so an image left over from an older lock is
# named as stale instead of quietly running old binaries. They are the image's
# own claim, written after the digests above were checked; the approval itself is
# the digest the operator pins (IDOU_SANDBOX_IMAGE).
LABEL com.mydoubao.codex="${CODEX_VERSION}" \
      com.mydoubao.codex.sha256="${CODEX_SHA256}" \
      com.mydoubao.lark-cli="${LARK_CLI_VERSION}" \
      com.mydoubao.lark-cli.sha256="${LARK_CLI_SHA256}" \
      com.mydoubao.release.upstreams.sha256="${RELEASE_UPSTREAMS_SHA256}" \
      com.mydoubao.platform="${SANDBOX_PLATFORM}"

# Runs as nobody, matching the uid the runtime launches with. The workspace is
# the one writable path and arrives as a bind mount at run time; everything else
# is read-only, so nothing a task does can persist into the next run.
WORKDIR /workspace
USER 65534:65534

ENV NODE_ENV=production \
    MYDOUBAO_SANDBOX=1 \
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1

# Replaced by the job's own command; present so `docker run` on this image
# without arguments reports what it is rather than failing obscurely.
CMD ["node", "/opt/mydoubao/bin/sandbox/run.js", "--self-test"]
